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
import { createInterface } from 'node:readline';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Peer, codexAdapter, acpAdapter, run, parseArgs, stage, providerOf, acpModel, reasonFromCodexError, codexResetsAt } from '../sandbox/engine.mjs';

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

/** An ACP agent. `session` is what session/new answers; `set` what setting the model answers; `prompt` how a turn goes. */
function acpServer({ session = /** @type {any} */ ({}), set = /** @type {((m: any) => any)|null} */ (null), prompt = /** @type {(send: (m: any) => void, m: any) => void} */ ((send, m) => send({ jsonrpc: '2.0', id: m.id, result: { stopReason: 'end_turn' } })) } = {}) {
  return standIn((m, send) => {
    const reply = (/** @type {any} */ body) => send({ jsonrpc: '2.0', id: m.id, ...body });
    if (m.method === 'initialize') reply({ result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } });
    else if (m.method === 'session/new') reply(session.error ? { error: session.error } : { result: { sessionId: 's-1', ...session } });
    else if (m.method === 'session/set_config_option' || m.method === 'session/set_model') reply(set ? set(m) : { error: { code: -32601, message: 'Method not found' } });
    else if (m.method === 'session/prompt') prompt(send, m);
  });
}
const modelOption = (/** @type {string} */ now) => [{ id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: now, options: [] }];
const ASKED = 'github-copilot/gpt-5';
function acpOn(/** @type {ReturnType<typeof standIn>} */ server, /** @type {any} */ opts = {}) {
  /** @type {string[]} */
  const said = [];
  /** @type {string[]} */
  const notes = [];
  const adapter = acpAdapter(new Peer(server.child), { engine: 'opencode', model: ASKED, cwd: '/work', mode: 'safe', say: (s) => said.push(s), note: (s) => notes.push(s), ...opts });
  return { adapter, said, notes };
}

test('ACP: an agent that falls back to another model without a word is caught by its own report, and asked nothing', async () => {
  // What OpenCode did in the step 1 probe: asked for a model it could not
  // reach, it took the request and stayed on its free one.
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
  return { socket, home: path.join(dir, 'home'), posts };
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
  assert.deepEqual(posts.at(-1)?.body.turn, { engine: 'codex', reason: 'auth', detail: 'this machine holds no codex sign-in for this member', model: null, usage: null, resetsAt: null });
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
  const { socket, home, posts } = await sessionSocket(t, (kind) => (kind === 'apikey:openrouter' ? { ok: true, kind, value: ' sk-or-v1-0123456789abcdef\n' } : { ok: false, error: 'not_granted', message: 'This session’s member names no engine that runs on that sign-in.' }));
  const server = acpServer({ session: { configOptions: modelOption('opencode/big-pickle') }, set: (m) => ({ result: { configOptions: modelOption(m.params.value) } }) });
  /** @type {any[]} */
  const spawned = [];
  const code = await run({ engine: 'opencode', model, mode: 'safe', prompt: 'Fix the redirect.' }, {
    socket, home, cwd: '/work', env: { PATH: '/usr/bin', OPENROUTER_API_KEY: 'somebody-elses' }, out: () => {}, stdin: typed(),
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
  const { socket, home, posts } = await sessionSocket(t, (kind) => ({ ok: true, kind, value: KEY }));
  const server = acpServer({ session: { error: { code: -32000, message: `401 from the provider: key ${KEY} is not valid` } } });
  /** @type {string[]} */
  const printed = [];
  await run({ engine: 'opencode', model: 'openrouter/anthropic/claude-sonnet-5.5', mode: 'safe', prompt: 'Go.' }, {
    socket, home, cwd: '/work', env: { PATH: '/usr/bin' }, out: (/** @type {string} */ s) => printed.push(s), stdin: typed(), spawnEngine: () => server.child,
  });
  const turn = posts.at(-1).body.turn;
  assert.equal(turn.detail, '401 from the provider: key [withheld] is not valid');
  assert.ok(!JSON.stringify(posts).includes(KEY), 'nothing this runner sent names the key');
  assert.ok(!printed.join('').includes(KEY), 'and nothing it printed in the pane');
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
