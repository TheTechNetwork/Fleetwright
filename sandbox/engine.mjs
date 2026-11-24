#!/usr/bin/env node
// The engine runner: what a session's pane runs when the member's engine is
// not Claude Code (docs/engines.md, "Where an engine runs").
//
// Claude Code is its own process in the pane and reports through its hooks.
// Every other engine speaks a protocol on a pipe and draws nothing, so this
// sits where `claude` would have been: it starts the engine's own server,
// speaks to it, prints what the agent says so the pane, the log and peek
// show it, and reports to the session's socket with the events the hooks
// use. The list, stop, the archive and a task's RESULT.md need no change.
//
// ONE FILE, NO IMPORTS BUT NODE'S, for the reason sandbox/hook.mjs is one:
// the image is built from this directory alone, and a session cannot reach
// the rest of the release. What it shares with the hub (the reasons a turn
// ends, the words that mean a limit) is mirrored in
// src/fleet/protocol/engines.js, and test/engines.test.js says if the two
// stop agreeing.
//
// BEFORE A TURN, two things, and no prompt is sent until both hold: the
// engine is signed in, and it says itself that it is on the model that was
// asked for. Cannot-tell is not a match. OpenCode given a model it could not
// reach used another one and said nothing (the step 1 probe), which is the
// case this exists for.
//
// IT NEVER DECIDES WHAT HAPPENS NEXT. It reports how the turn ended and
// waits. Whether another engine takes over is the hub's, which holds the
// member's list (src/core/sessions.js, handOn).
//
// THE CREDENTIAL IS ASKED FOR, never mounted or in the environment: the
// socket this session can reach answers for this session's member and
// nobody else (src/core/hook-socket.js), as it does for `fleet-cred`.

import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

/** Why a turn ended. Mirrored from src/fleet/protocol/engines.js. */
export const TURN_REASONS = Object.freeze(['done', 'limit', 'auth', 'model', 'refused', 'cut', 'cancelled', 'error']);

/**
 * Words that mean an account's limit, for the engines with no field for it.
 * Mirrored in src/fleet/protocol/engines.js. A limit worded some way nobody
 * has seen is an `error`, and hands nothing on: that is the safe side.
 */
export const LIMIT_WORDS = /rate.?limit|usage.?limit|quota|too many requests|\b429\b|credit balance|limit (?:reached|exceeded)|out of (?:credits|usage)/i;
/** Words that mean the sign-in is missing or ended. Mirrored the same way. */
export const AUTH_WORDS = /not (?:logged|signed) in|unauthori[sz]ed|authentication|\b401\b|invalid (?:api key|token|credentials)|(?:token|credentials|session) (?:has |have )?expired|log ?in required|please (?:log|sign) in/i;

/** What each engine is started with, and the vault item it runs on. */
export const RUNS = Object.freeze({
  codex: Object.freeze({ protocol: 'codex', command: ['codex', 'app-server'], credential: 'codex', bin: 'FLEETWRIGHT_CODEX_BIN' }),
  // One row an ACP agent. Another agent that speaks the protocol is a row
  // here and a credential rule in `stage`, not a new adapter.
  opencode: Object.freeze({ protocol: 'acp', command: ['opencode', 'acp'], credential: 'copilot', bin: 'FLEETWRIGHT_OPENCODE_BIN' }),
});

/** One printable line, bounded. An engine's error is its own words and could be anything. */
export function line(value, max = 200) {
  if (value === undefined || value === null) return null;
  const s = String(value).split('\n')[0].replace(/[^\x20-\x7e]/g, '').trim();
  return s ? s.slice(0, max) : null;
}

/** A turn's end in the one shape, from whatever an adapter worked out. */
export function ended(engine, reason, extra = {}) {
  return {
    engine,
    reason: TURN_REASONS.includes(reason) ? reason : 'error',
    detail: line(extra.detail),
    model: line(extra.model, 80),
    usage: extra.usage && Number.isInteger(extra.usage.input) && Number.isInteger(extra.usage.output) ? { input: extra.usage.input, output: extra.usage.output } : null,
    resetsAt: Number.isFinite(extra.resetsAt) && extra.resetsAt > 0 ? Math.round(extra.resetsAt) : null,
  };
}

// ── JSON-RPC over a child's pipes ───────────────────────────────────────────

/**
 * One line a message, both ways. `version` is "2.0" for an ACP agent and
 * null for Codex's app server, whose messages carry no `jsonrpc` field.
 *
 * It never throws into its caller's loop: a line that is not JSON is the
 * engine printing something, and is dropped; the pipe closing settles every
 * request still waiting with an error that says so.
 */
export class Peer {
  /**
   * @param {{ stdin: import('node:stream').Writable, stdout: import('node:stream').Readable }} pipes
   * @param {{ version?: string|null }} [opts]
   */
  constructor(pipes, { version = '2.0' } = {}) {
    this.pipes = pipes;
    this.version = version;
    this.nextId = 1;
    /** @type {Map<number, { resolve: (v: any) => void, reject: (e: any) => void, timer: any }>} */
    this.waiting = new Map();
    /** @type {(method: string, params: any) => void} */
    this.onNotification = () => {};
    /** Answers the engine's own requests. Returning undefined is "method not found". @type {(method: string, params: any) => any} */
    this.onRequest = () => undefined;
    this.closed = false;
    const lines = createInterface({ input: pipes.stdout });
    lines.on('line', (text) => this.#read(text));
    lines.on('close', () => this.#end('the engine closed its pipe'));
    pipes.stdin.on('error', () => this.#end('the engine closed its pipe'));
  }

  #send(message) {
    if (this.closed) return;
    try {
      this.pipes.stdin.write(`${JSON.stringify(this.version ? { jsonrpc: this.version, ...message } : message)}\n`);
    } catch {
      this.#end('the engine closed its pipe');
    }
  }

  #end(why) {
    if (this.closed) return;
    this.closed = true;
    for (const [, w] of this.waiting) {
      clearTimeout(w.timer);
      w.reject(Object.assign(new Error(why), { code: 'closed' }));
    }
    this.waiting.clear();
    this.onClose?.(why);
  }

  #read(text) {
    let m;
    try {
      m = JSON.parse(text);
    } catch {
      return;
    }
    if (!m || typeof m !== 'object') return;
    if (typeof m.method === 'string') {
      if (m.id === undefined || m.id === null) {
        try {
          this.onNotification(m.method, m.params);
        } catch { /* a handler's own fault is not the engine's */ }
        return;
      }
      // The engine asking this side for something.
      Promise.resolve()
        .then(() => this.onRequest(m.method, m.params))
        .then(
          (result) => this.#send(result === undefined ? { id: m.id, error: { code: -32601, message: `Method not found: ${m.method}` } } : { id: m.id, result }),
          (e) => this.#send({ id: m.id, error: { code: -32603, message: String(e?.message ?? e).slice(0, 200) } }),
        );
      return;
    }
    const w = this.waiting.get(m.id);
    if (!w) return;
    this.waiting.delete(m.id);
    clearTimeout(w.timer);
    if (m.error) w.reject(Object.assign(new Error(String(m.error.message ?? 'the engine refused')), { code: m.error.code, data: m.error.data }));
    else w.resolve(m.result);
  }

  /** @param {string} method @param {any} [params] @param {number} [timeoutMs] 0 waits for as long as it takes */
  request(method, params, timeoutMs = 30_000) {
    if (this.closed) return Promise.reject(Object.assign(new Error('the engine closed its pipe'), { code: 'closed' }));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = timeoutMs
        ? setTimeout(() => {
            this.waiting.delete(id);
            reject(Object.assign(new Error(`the engine did not answer ${method} in ${Math.round(timeoutMs / 1000)}s`), { code: 'timeout' }));
          }, timeoutMs)
        : null;
      this.waiting.set(id, { resolve, reject, timer });
      this.#send({ id, method, ...(params === undefined ? {} : { params }) });
    });
  }

  /** @param {string} method @param {any} [params] */
  notify(method, params) {
    this.#send({ method, ...(params === undefined ? {} : { params }) });
  }
}

// ── Codex, through `codex app-server` ───────────────────────────────────────

/** A failed Codex turn's error, as a reason. The names are the app server's own (`codexErrorInfo`). */
export function reasonFromCodexError(error) {
  const info = error?.codexErrorInfo;
  const name = typeof info === 'string' ? info : info && typeof info === 'object' ? Object.keys(info)[0] : '';
  if (name === 'usageLimitExceeded' || name === 'rateLimitExceeded') return 'limit';
  if (name === 'unauthorized') return 'auth';
  if (name === 'modelNotFound') return 'model';
  if (name === 'cyberPolicy' || name === 'bioPolicy' || name === 'misalignmentPolicyViolation') return 'refused';
  if (name === 'contextWindowExceeded' || name === 'sessionBudgetExceeded') return 'cut';
  // An error with no name the app server knows: its words, held to the same
  // two lists the engines without names are.
  const said = String(error?.message ?? '');
  if (LIMIT_WORDS.test(said)) return 'limit';
  if (AUTH_WORDS.test(said)) return 'auth';
  return 'error';
}

/** When the limit a rate-limit update describes lifts, in epoch ms, or null. The app server says seconds. */
export function codexResetsAt(rateLimits) {
  const windows = [rateLimits?.primary, rateLimits?.secondary].filter((w) => w && Number(w.usedPercent) >= 100 && Number.isFinite(Number(w.resetsAt)));
  if (!windows.length) return null;
  return Math.max(...windows.map((w) => Number(w.resetsAt))) * 1000;
}

/**
 * @param {Peer} peer
 * @param {{ engine?: string, model?: string|null, cwd: string, mode: string, say: (text: string) => void, note: (text: string) => void }} opts
 */
export function codexAdapter(peer, { engine = 'codex', model = null, cwd, mode, say, note }) {
  let threadId = '';
  let ran = model;
  let rateLimits = null;
  /** The turn in flight: what settles it, and what was heard on the way. */
  let turn = null;
  const allow = mode === 'dangerous';

  peer.onNotification = (method, params) => {
    if (method === 'account/rateLimits/updated') rateLimits = { ...(rateLimits ?? {}), ...(params?.rateLimits ?? {}) };
    if (!turn) return;
    if (method === 'item/agentMessage/delta' && typeof params?.delta === 'string') say(params.delta);
    else if (method === 'item/completed' && params?.item?.type === 'agentMessage') say('\n');
    else if (method === 'thread/tokenUsage/updated') {
      const total = params?.tokenUsage?.total;
      if (total && Number.isInteger(total.inputTokens) && Number.isInteger(total.outputTokens)) turn.usage = { input: total.inputTokens, output: total.outputTokens };
    } else if (method === 'model/rerouted') {
      // The app server moved the turn to another model. Not what was asked
      // for, so the turn is stopped and ends as `model`.
      turn.rerouted = line(params?.toModel ?? params?.model ?? 'another model', 80);
      // The turn's id is the notice's own: it can arrive before the answer
      // to turn/start has been read.
      peer.request('turn/interrupt', { threadId, turnId: String(params?.turnId ?? turn.id) }).catch(() => {});
    } else if (method === 'error' && params?.willRetry === false) turn.error = params.error;
    else if (method === 'turn/completed' && params?.threadId === threadId) turn.settle(params.turn);
  };
  // What the app server asks before it runs a command or writes a file. A
  // session that asks first has nobody at this dialog, so it declines and
  // says so; one that does not allows it, as Claude Code's are allowed.
  peer.onRequest = (method) => {
    if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') {
      if (!allow) note('Declined something Codex asked to do: this session asks before it runs commands, and Codex’s questions cannot be answered from here yet.');
      return { decision: allow ? 'accept' : 'decline' };
    }
    return undefined;
  };

  return {
    /** Signed in, and on the model asked for? Sends no prompt. */
    async open() {
      try {
        await peer.request('initialize', { clientInfo: { name: 'fleetwright', title: 'Fleetwright', version: '1' }, capabilities: null });
        peer.notify('initialized');
        const who = await peer.request('account/read', { refreshToken: false });
        if (!who?.account && who?.requiresOpenaiAuth !== false) return ended(engine, 'auth', { detail: 'Codex is not signed in on this machine' });
        const started = await peer.request('thread/start', {
          ...(model ? { model } : {}),
          cwd,
          approvalPolicy: allow ? 'never' : 'on-request',
          sandbox: allow ? 'danger-full-access' : 'workspace-write',
        });
        threadId = String(started?.thread?.id ?? '');
        if (!threadId) return ended(engine, 'error', { detail: 'Codex started no thread' });
        ran = typeof started?.model === 'string' ? started.model : null;
        if (model && ran !== model) return ended(engine, 'model', { model: ran, detail: `asked for ${model}` });
        return null;
      } catch (e) {
        return ended(engine, reasonFromCodexError({ message: e?.message, codexErrorInfo: e?.data?.codexErrorInfo }), { detail: e?.message });
      }
    },

    /** @param {string} prompt */
    async turn(prompt) {
      const done = new Promise((settle) => {
        turn = { id: '', settle, usage: null, error: null, rerouted: null };
      });
      try {
        const begun = await peer.request('turn/start', { threadId, input: [{ type: 'text', text: prompt, text_elements: [] }] });
        turn.id = String(begun?.turn?.id ?? '');
      } catch (e) {
        turn = null;
        return ended(engine, reasonFromCodexError({ message: e?.message, codexErrorInfo: e?.data?.codexErrorInfo }), { detail: e?.message, model: ran });
      }
      const closed = new Promise((settle) => {
        peer.onClose = (why) => settle({ status: 'failed', error: { message: why } });
      });
      const finished = await Promise.race([done, closed]);
      const heard = turn;
      turn = null;
      const extra = { model: ran, usage: heard.usage };
      if (heard.rerouted) return ended(engine, 'model', { ...extra, model: heard.rerouted, detail: `asked for ${model ?? 'its own model'}` });
      if (finished?.status === 'completed') return ended(engine, 'done', extra);
      const error = finished?.error ?? heard.error;
      const reason = finished?.status === 'interrupted' && !error ? 'cancelled' : reasonFromCodexError(error);
      // A window at 100% with a failed turn is a limit, whatever the error's
      // name was: the rate-limit update is the app server's own best signal.
      const lifts = codexResetsAt(rateLimits);
      const settled = reason === 'error' && lifts ? 'limit' : reason;
      return ended(engine, settled, { ...extra, detail: error?.message, resetsAt: settled === 'limit' ? lifts : null });
    },
  };
}

// ── An ACP agent ────────────────────────────────────────────────────────────

/** The model an ACP session says it is on, from whichever of the two shapes the agent speaks, or null. */
export function acpModel(session) {
  const option = Array.isArray(session?.configOptions) ? session.configOptions.find((o) => o?.category === 'model' && typeof o?.currentValue === 'string') : null;
  if (option) return { now: option.currentValue, option: option.id, listed: null };
  const models = session?.models;
  if (models && typeof models.currentModelId === 'string') {
    return { now: models.currentModelId, option: null, listed: Array.isArray(models.availableModels) ? models.availableModels.map((m) => String(m?.modelId ?? '')) : [] };
  }
  return null;
}

/** An ACP error, as a reason. `-32000` is the protocol's own Authentication required. */
export function reasonFromAcpError(e) {
  const said = String(e?.message ?? '');
  if (e?.code === -32000 || AUTH_WORDS.test(said)) return 'auth';
  if (LIMIT_WORDS.test(said) || LIMIT_WORDS.test(JSON.stringify(e?.data ?? ''))) return 'limit';
  return 'error';
}

const ACP_STOPS = Object.freeze({ end_turn: 'done', refusal: 'refused', cancelled: 'cancelled', max_tokens: 'cut', max_turn_requests: 'cut' });

/**
 * @param {Peer} peer
 * @param {{ engine: string, model: string, cwd: string, mode: string, say: (text: string) => void, note: (text: string) => void }} opts
 */
export function acpAdapter(peer, { engine, model, cwd, mode, say, note }) {
  let sessionId = '';
  let usage = null;
  const allow = mode === 'dangerous';

  peer.onNotification = (method, params) => {
    if (method !== 'session/update' || params?.sessionId !== sessionId) return;
    const update = params.update;
    if (update?.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text' && typeof update.content.text === 'string') say(update.content.text);
  };
  peer.onRequest = (method, params) => {
    if (method !== 'session/request_permission') return undefined;
    const options = Array.isArray(params?.options) ? params.options : [];
    const pick = (/** @type {string[]} */ kinds) => options.find((o) => kinds.includes(o?.kind));
    const chosen = allow ? pick(['allow_once', 'allow_always']) : pick(['reject_once', 'reject_always']);
    if (!allow) note(`Declined something ${engine} asked to do: this session asks before it runs commands, and this engine’s questions cannot be answered from here yet.`);
    return chosen ? { outcome: { outcome: 'selected', optionId: chosen.optionId } } : { outcome: { outcome: 'cancelled' } };
  };

  return {
    /** Signed in, and on the model asked for? Sends no prompt. */
    async open() {
      try {
        await peer.request('initialize', {
          protocolVersion: 1,
          // Nothing offered: the agent reads and writes the workspace itself.
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
          clientInfo: { name: 'fleetwright', title: 'Fleetwright', version: '1' },
        });
        const session = await peer.request('session/new', { cwd, mcpServers: [] });
        sessionId = String(session?.sessionId ?? '');
        if (!sessionId) return ended(engine, 'error', { detail: 'the agent started no session' });
        let says = acpModel(session);
        // CANNOT TELL IS NOT A MATCH. An agent that does not say which model
        // it is on is not asked anything.
        if (!says) return ended(engine, 'model', { detail: `asked for ${model}, and the agent does not say which model it is on` });
        if (says.now !== model) {
          if (says.option) {
            // Set, then read back from the agent's own answer.
            const set = await peer.request('session/set_config_option', { sessionId, configId: says.option, value: model });
            says = acpModel(set) ?? { now: '', option: says.option, listed: null };
          } else if (says.listed?.includes(model)) {
            // The older shape has no read-back: the agent listed the model
            // as one it has, and took the request without an error.
            await peer.request('session/set_model', { sessionId, modelId: model });
            says = { ...says, now: model };
          }
        }
        if (says.now !== model) return ended(engine, 'model', { model: says.now || null, detail: `asked for ${model}` });
        return null;
      } catch (e) {
        return ended(engine, reasonFromAcpError(e), { detail: e?.message });
      }
    },

    /** @param {string} prompt */
    async turn(prompt) {
      usage = null;
      try {
        // No deadline: a turn takes as long as the work does.
        const answer = await peer.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: prompt }] }, 0);
        say('\n');
        const u = answer?.usage;
        if (u && Number.isInteger(u.inputTokens) && Number.isInteger(u.outputTokens)) usage = { input: u.inputTokens, output: u.outputTokens };
        const reason = ACP_STOPS[answer?.stopReason] ?? 'error';
        return ended(engine, reason, { model, usage, detail: reason === 'error' ? `stopped with ${line(answer?.stopReason, 40) ?? 'no reason'}` : null });
      } catch (e) {
        return ended(engine, reasonFromAcpError(e), { model, usage, detail: e?.message });
      }
    },
  };
}

// ── The session's socket ────────────────────────────────────────────────────

const SOCKET = process.env.AGENT_SESSION_HOOK_SOCKET || (existsSync('/run/hub/hub.sock') ? '/run/hub/hub.sock' : '/run/hub.sock');

/** POST to this session's own socket. Resolves to the answer, or null when nothing answered. */
export function post(socketPath, pathname, body) {
  return new Promise((resolve) => {
    const data = JSON.stringify(body);
    const req = request({ socketPath, path: pathname, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) }, timeout: 5000 }, (res) => {
      let text = '';
      res.on('data', (c) => (text += c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(text));
        } catch {
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => req.destroy());
    req.end(data);
  });
}

/**
 * Put the engine's credential where the engine reads it, from the member's
 * vault item as the socket handed it over. Returns what to watch for
 * changes: Codex renews its own tokens into the file, and the renewed file
 * is handed back to the box, which is the one machine that holds it.
 *
 * @param {string} engine @param {string} value @param {string} home
 * @returns {{ ok: true, file: string|null } | { ok: false, text: string }}
 */
export function stage(engine, value, home) {
  try {
    if (engine === 'codex') {
      const dir = process.env.CODEX_HOME || path.join(home, '.codex');
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const file = path.join(dir, 'auth.json');
      writeFileSync(file, value, { mode: 0o600 });
      return { ok: true, file };
    }
    if (engine === 'opencode') {
      // Where OpenCode keeps its providers' sign-ins, in the shape it writes
      // one for GitHub Copilot. If a later OpenCode reads another shape, the
      // model check before a turn is what catches it: an agent that cannot
      // reach the model asked for does not report being on it.
      const dir = path.join(process.env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'opencode');
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeFileSync(path.join(dir, 'auth.json'), `${JSON.stringify({ 'github-copilot': { type: 'oauth', refresh: value.trim(), access: '', expires: 0 } })}\n`, { mode: 0o600 });
      return { ok: true, file: null };
    }
    return { ok: false, text: `no credential rule for ${engine}` };
  } catch (e) {
    return { ok: false, text: `could not write ${engine}’s sign-in: ${e?.message ?? e}` };
  }
}

/** `--engine codex --model gpt --mode safe -- <prompt>`, as an object. The prompt is the last argument, whole. */
export function parseArgs(argv) {
  const out = { engine: '', model: null, mode: 'safe', prompt: '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--engine') out.engine = String(argv[++i] ?? '');
    else if (a === '--model') out.model = String(argv[++i] ?? '') || null;
    else if (a === '--mode') out.mode = argv[++i] === 'dangerous' ? 'dangerous' : 'safe';
    else if (a === '--') {
      out.prompt = argv.slice(i + 1).join(' ');
      break;
    } else {
      out.prompt = argv.slice(i).join(' ');
      break;
    }
  }
  return out;
}

/**
 * Run one engine in this pane until the session is stopped.
 *
 * @param {{ engine: string, model: string|null, mode: string, prompt: string }} args
 * @param {{ socket?: string, home?: string, cwd?: string, out?: (text: string) => void, stdin?: import('node:stream').Readable, spawnEngine?: Function, env?: Record<string, string|undefined> }} [io]
 */
export async function run(args, io = {}) {
  const socket = io.socket ?? SOCKET;
  const home = io.home ?? homedir();
  const cwd = io.cwd ?? process.cwd();
  const env = io.env ?? process.env;
  const out = io.out ?? ((text) => process.stdout.write(text));
  const note = (/** @type {string} */ text) => out(`\n[fleetwright] ${text}\n`);
  const report = (/** @type {any} */ turn) => post(socket, '/internal/session-event', { event: 'TurnEnded', detail: turn.reason, turn });
  const spec = RUNS[args.engine];
  if (!spec) {
    note(`${line(args.engine, 40) ?? 'No engine'} is not an engine this runner speaks to.`);
    return 2;
  }

  /** One attempt at being ready: the credential, the engine's server, the two checks. */
  const open = async () => {
    const got = await post(socket, '/internal/engine-credential', { kind: spec.credential });
    if (!got?.ok || typeof got.value !== 'string' || !got.value) {
      return { failed: ended(args.engine, 'auth', { detail: got?.message ?? `this machine holds no ${spec.credential} sign-in for this member` }) };
    }
    const staged = stage(args.engine, got.value, home);
    if (!staged.ok) return { failed: ended(args.engine, 'error', { detail: staged.text }) };
    const command = env[spec.bin] ? [env[spec.bin]] : [spec.command[0]];
    let child;
    try {
      child = (io.spawnEngine ?? spawn)(command[0], spec.command.slice(1), { cwd, env, stdio: ['pipe', 'pipe', 'inherit'] });
    } catch (e) {
      return { failed: ended(args.engine, 'error', { detail: `could not start ${command[0]}: ${e?.message ?? e}` }) };
    }
    /** @type {string|null} */
    let spawnError = null;
    child.on?.('error', (e) => {
      spawnError = e?.code === 'ENOENT' ? `${command[0]} is not installed on this machine` : String(e?.message ?? e);
    });
    const peer = new Peer(child, { version: spec.protocol === 'acp' ? '2.0' : null });
    const adapter = spec.protocol === 'acp'
      ? acpAdapter(peer, { engine: args.engine, model: String(args.model ?? ''), cwd, mode: args.mode, say: out, note })
      : codexAdapter(peer, { engine: args.engine, model: args.model, cwd, mode: args.mode, say: out, note });
    const failed = await adapter.open();
    if (failed) {
      child.kill?.();
      return { failed: spawnError ? ended(args.engine, 'error', { detail: spawnError }) : failed };
    }
    return { adapter, child, file: staged.file, was: staged.file ? got.value : null };
  };

  /** Hand a renewed sign-in back to the box, when the engine rewrote its file. */
  const keep = async (/** @type {any} */ live) => {
    if (!live?.file) return;
    try {
      const now = readFileSync(live.file, 'utf8');
      if (now && now !== live.was) {
        const kept = await post(socket, '/internal/engine-credential', { kind: spec.credential, value: now });
        if (kept?.ok) live.was = now;
      }
    } catch { /* gone or unreadable: the box keeps what it had */ }
  };

  let live = null;
  let prompt = args.prompt;
  const typed = createInterface({ input: io.stdin ?? process.stdin });
  const lines = typed[Symbol.asyncIterator]();
  for (;;) {
    if (prompt.trim()) {
      await post(socket, '/internal/session-event', { event: 'UserPromptSubmit' });
      if (!live) {
        const opened = await open();
        if (opened.failed) {
          note(`${args.engine} did not start a turn: ${opened.failed.reason}${opened.failed.detail ? ` (${opened.failed.detail})` : ''}.`);
          await report(opened.failed);
        } else live = opened;
      }
      if (live) {
        const turn = await live.adapter.turn(prompt);
        await keep(live);
        if (turn.reason !== 'done') note(`${args.engine}’s turn ended: ${turn.reason}${turn.detail ? ` (${turn.detail})` : ''}.`);
        await report(turn);
        // A pipe that closed is an engine that is gone: the next line typed
        // starts it again.
        if (live.child.exitCode !== null && live.child.exitCode !== undefined) live = null;
      }
    }
    out('\n> ');
    const next = await lines.next();
    if (next.done) break;
    prompt = String(next.value ?? '');
  }
  live?.child.kill?.();
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.on('SIGTERM', () => process.exit(0));
  process.on('SIGHUP', () => process.exit(0));
  run(parseArgs(process.argv.slice(2))).then((code) => process.exit(code), (e) => {
    process.stdout.write(`\n[fleetwright] the engine runner stopped: ${e?.message ?? e}\n`);
    process.exit(1);
  });
}
