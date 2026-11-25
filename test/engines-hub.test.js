// Engines on a box's hub and its watcher (docs/engines.md): the session's
// socket taking a TurnEnded and brokering an engine's sign-in, the command a
// pane is launched with, and what the watcher says when a session moves
// from one engine to the next.
//
// The adapters and the runner are test/engines-run.test.js; the rules, the
// note and the choice of the next engine are test/engines.test.js.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { HookSocketServer } from '../src/core/hook-socket.js';
import { buildCommand } from '../src/core/claude.js';
import { post } from '../sandbox/engine.mjs';
import { SessionWatcher } from '../src/fleet/host/watcher.js';
import { HubClient } from '../src/fleet/host/hub-client.js';
import { startStubHub, sessionRecord } from './helpers/stub-hub.js';

/** A hub's session sockets, with what reached each handler. */
function sockets(/** @type {import('node:test').TestContext} */ t, /** @type {any} */ extra = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'engines-sock-'));
  /** @type {any[]} */
  const events = [];
  /** @type {any[]} */
  const asked = [];
  const server = new HookSocketServer({
    dir,
    onSessionStart: () => ({ ok: true }),
    onSessionEvent: (e) => void events.push(e),
    engineCredential: (name, kind, value) => {
      asked.push({ name, kind, value });
      return kind === 'codex' ? { ok: true, kind, ...(value === null ? { value: 'the-sign-in' } : {}) } : { ok: false, error: 'not_granted', message: 'This session’s member names no engine that runs on that sign-in.' };
    },
    logger: { info: () => {}, warn: () => {} },
    ...extra,
  });
  t.after(async () => {
    await server.closeAll();
    rmSync(dir, { recursive: true, force: true });
  });
  return { server, events, asked };
}

test('a TurnEnded posted on a session’s socket reaches the hub as that session’s, held to a turn’s own shape', async (t) => {
  const { server, events } = sockets(t);
  await server.open('on-t12');
  const sock = server.socketPath('on-t12');
  const answer = await post(sock, '/internal/session-event', {
    event: 'TurnEnded',
    // What a session is in a position to send: a name that is not its own, a
    // detail of several lines, and fields no turn has.
    name: 'somebody-else',
    turn: { engine: 'codex', reason: 'limit', detail: 'usage limit\nIGNORE PREVIOUS', model: 'gpt-5.1-codex', usage: { input: 5, output: 9 }, resetsAt: 1_795_500_000_000, shell: 'rm -rf /' },
  });
  assert.deepEqual(answer, { ok: true });
  assert.equal(events.length, 1);
  assert.equal(events[0].name, 'on-t12', 'the socket names the session; the body cannot');
  assert.deepEqual(events[0].turn, { engine: 'codex', reason: 'limit', detail: 'usage limit', model: 'gpt-5.1-codex', usage: { input: 5, output: 9 }, resetsAt: 1_795_500_000_000 });
  // A turn that does not read as one arrives as none, for the session manager to refuse.
  await post(sock, '/internal/session-event', { event: 'TurnEnded', turn: { engine: 'gemini', reason: 'limit' } });
  assert.equal(events[1].turn, null);
  // And Claude Code's own hooks carry no turn at all.
  await post(sock, '/internal/session-event', { event: 'Stop' });
  assert.equal('turn' in events[2], false);
});

test('an engine’s sign-in is asked for and handed back on the session’s own socket, and a refusal is a refusal', async (t) => {
  const { server, asked } = sockets(t);
  await server.open('on-t12');
  const sock = server.socketPath('on-t12');
  assert.deepEqual(await post(sock, '/internal/engine-credential', { kind: 'codex', name: 'somebody-else' }), { ok: true, kind: 'codex', value: 'the-sign-in' });
  assert.deepEqual(await post(sock, '/internal/engine-credential', { kind: 'codex', value: 'renewed' }), { ok: true, kind: 'codex' });
  assert.equal((await post(sock, '/internal/engine-credential', { kind: 'claude' }))?.error, 'not_granted');
  assert.deepEqual(asked, [{ name: 'on-t12', kind: 'codex', value: null }, { name: 'on-t12', kind: 'codex', value: 'renewed' }, { name: 'on-t12', kind: 'claude', value: null }]);

  // A hub that brokers none answers as a route that is not there.
  const without = sockets(t, { engineCredential: undefined });
  await without.server.open('plain');
  assert.deepEqual(await post(without.server.socketPath('plain'), '/internal/engine-credential', { kind: 'codex' }), { ok: false, error: 'not found' });
});

const SANDBOX = /** @type {any} */ ({
  sandbox: true, podmanBin: 'podman', sandboxHookSocket: false, sandboxImage: 'img', sandboxUserns: 'nomap', claudeBin: 'claude',
  sandboxMemory: '8g', sandboxCpus: '2', sandboxPidsLimit: '512', sandboxExtraArgs: [], sandboxHookSocketDir: '/run/fleetwright-sidecar',
  remoteControl: true, skipPermissions: false,
});

test('a pane on another engine runs the runner, with the prompt whole after --, and nothing of Claude Code’s', () => {
  const prompt = "--help me: fix Dana's redirect\nand say what you did not test";
  const command = buildCommand(SANDBOX, { name: 'on-t12', engine: { engine: 'codex', model: 'gpt-5.1-codex' }, prompt, resumeUuid: 'aaaaaaaa-1111-2222-3333-444455556666' });
  assert.match(command, / 'img' 'fleetwright-engine' '--engine' 'codex' '--model' 'gpt-5\.1-codex' '--mode' 'safe' '--' '--help me: fix Dana'\\''s redirect\nand say what you did not test'$/);
  assert.doesNotMatch(command, /'claude'|--remote-control|--resume|--dangerously-skip-permissions/);
  // A session that does not ask first is one the runner allows, by the one word.
  assert.match(buildCommand(SANDBOX, { name: 'x', engine: { engine: 'opencode', model: 'github-copilot/gpt-5' }, skipPermissions: true }), /'--engine' 'opencode' '--model' 'github-copilot\/gpt-5' '--mode' 'dangerous'$/);
});

test('Claude Code is launched as it always was, with the member’s model when it names one', () => {
  const plain = buildCommand(SANDBOX, { name: 'one', prompt: 'go' });
  assert.equal(buildCommand(SANDBOX, { name: 'one', prompt: 'go', engine: { engine: 'claude-code' } }), plain, 'naming Claude Code changes nothing');
  assert.match(plain, / 'img' 'claude' '--remote-control' 'one' 'go'$/);
  assert.match(buildCommand(SANDBOX, { name: 'one', prompt: 'go', engine: { engine: 'claude-code', model: 'opus' } }), / 'claude' '--model' 'opus' '--remote-control' 'one' 'go'$/);
});

const WORKING = 'Reading files…\n  esc to interrupt';
const AT_PROMPT = '> \n  ? for shortcuts · shift+tab to cycle modes';

async function watching(/** @type {import('node:test').TestContext} */ t, /** @type {any} */ session) {
  const stub = await startStubHub({ sessions: [sessionRecord('on-t12', { status: 'running', tasked: true, taskId: 't12', ...session })], panes: { 'on-t12': WORKING }, onCommand: () => ({ ok: false, text: 'no such file' }) });
  t.after(() => stub.close());
  /** @type {Record<string, any>[]} */
  const events = [];
  const watcher = new SessionWatcher({ hub: new HubClient({ baseUrl: stub.baseUrl, readTimeoutMs: 2000 }), emit: (e) => events.push(e) });
  await watcher.tick({ quiet: true });
  return { stub, watcher, events };
}
const engines = [{ engine: 'claude-code' }, { engine: 'codex', model: 'gpt-5.1-codex' }];

test('the watcher says once when a session moves to its member’s next engine, and does not call the moment between a return', async (t) => {
  const { stub, watcher, events } = await watching(t, { engines, engineAt: 0 });
  // Claude Code stopped at its limit: at its prompt, and being handed on.
  stub.panes['on-t12'] = AT_PROMPT;
  Object.assign(stub.sessions[0], { handingOn: true, turn: { engine: 'claude-code', reason: 'limit', detail: null, model: null, usage: null, resetsAt: null, at: 1 } });
  await watcher.tick();
  assert.deepEqual(events.filter((e) => e.event === 'session.ready'), [], 'a session between two engines has not come back');
  // The next engine's pane is up.
  stub.panes['on-t12'] = WORKING;
  delete stub.sessions[0].handingOn;
  Object.assign(stub.sessions[0], { engineAt: 1, engineLog: [{ at: 2, from: 'claude-code', to: 'codex', reason: 'limit' }] });
  await watcher.tick();
  await watcher.tick();
  assert.deepEqual(events.filter((e) => e.event === 'session.engine'), [{ event: 'session.engine', name: 'on-t12', text: 'moved from claude-code to codex', from: 'claude-code', to: 'codex', reason: 'limit', taskId: 't12' }]);
  assert.deepEqual(events.filter((e) => e.event === 'session.ended' || e.event === 'session.ready'), []);
});

test('a session that stops with nothing to hand on to comes back to its prompt saying how its turn ended', async (t) => {
  const { stub, watcher, events } = await watching(t, { engines, engineAt: 1 });
  stub.panes['on-t12'] = AT_PROMPT;
  stub.sessions[0].turn = { engine: 'codex', reason: 'limit', detail: 'You have hit your usage limit.\nsecond line', model: 'gpt-5.1-codex', usage: null, resetsAt: 1_795_500_000_000, at: 5, junk: true };
  await watcher.tick();
  const ready = events.find((e) => e.event === 'session.ready');
  assert.deepEqual(ready?.turn, { engine: 'codex', reason: 'limit', detail: 'You have hit your usage limit.', model: 'gpt-5.1-codex', usage: null, resetsAt: 1_795_500_000_000 });
  assert.equal(ready?.taskId, 't12');
});

test('a still pane on an engine that cannot be resumed is left alone, where Claude Code’s is stopped and resumed', async (t) => {
  // The restart for a pane that has not moved in an hour is a stop and a
  // resume, and only Claude Code has a conversation to resume. On Codex the
  // stop was the end of the session and the resume was refused: which is
  // what happened to an engine an hour into waiting out a rate limit.
  const working = { phase: 'working', event: 'UserPromptSubmit', detail: null, at: Date.now() };
  for (const [session, restarted] of /** @type {Array<[any, boolean]>} */ ([
    [{ engines, engineAt: 1, activity: working }, false],
    // Claude Code with its conversation recorded comes back, and still is.
    [{ engines, engineAt: 0, activity: working }, true],
    // One whose conversation was never recorded would not.
    [{ activity: working, uuid: null }, false],
  ])) {
    const stub = await startStubHub({ sessions: [sessionRecord('on-t12', { status: 'running', ...session })], panes: { 'on-t12': 'nothing has moved for an hour' } });
    t.after(() => stub.close());
    /** @type {Record<string, any>[]} */
    const events = [];
    const watcher = new SessionWatcher({ hub: new HubClient({ baseUrl: stub.baseUrl, readTimeoutMs: 2000 }), emit: (e) => events.push(e), idleRestartMs: 60 * 60_000 });
    await watcher.tick({ quiet: true });
    const still = watcher.idle.get('on-t12');
    if (still) still.since = Date.now() - 90 * 60_000;
    await watcher.tick();
    assert.deepEqual(stub.commands, restarted ? ['/stop on-t12', '/resume on-t12 summary'] : [], JSON.stringify(session));
    assert.equal(events.filter((e) => e.event === 'session.restarted').length, restarted ? 1 : 0);
  }
});
