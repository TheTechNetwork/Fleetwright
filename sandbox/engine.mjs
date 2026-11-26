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
// THE SIGN-IN IS THE MACHINE'S FIRST, and is asked for only when there is
// none. A box mounts its member's engine home into the session
// (FLEETWRIGHT_ENGINE_HOME), where an engine signed in on this machine keeps
// its own sign-in and renews it. With one there, nothing is asked of
// anybody. With none, the member's pasted item is asked for, never mounted
// or in the environment: the socket this session can reach answers for this
// session's member and nobody else (src/core/hook-socket.js), as it does
// for `fleet-cred`.
//
// AND IT IS HOW AN ENGINE IS SIGNED IN THERE. `--signin <engine>` runs the
// engine's own device-code sign-in in a container that has the engine home
// and nothing else of a session, prints the page and the code as one line
// of JSON, waits for the engine to say how it ended, and prints that as a
// second. `--signout <engine>` has the engine remove its sign-in. See
// "Signing in on the machine", below and in docs/engines.md.

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { request } from 'node:http';
import { mkdirSync, writeFileSync, readFileSync, existsSync, statSync } from 'node:fs';
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
 *
 * MONEY RUNNING OUT IS A LIMIT, and is how a metered key usually reaches
 * one. OpenRouter answers 402 "Your account or API key has insufficient
 * credits" (its `payment_required`, https://openrouter.ai/docs/api_reference/errors-and-debugging),
 * or "This request requires more credits"; a gateway says "Insufficient
 * funds"; Copilot says its premium request allowance is exceeded. Every one
 * of those read as an `error`, so the member's next engine was never
 * started for the ordinary way a paid engine stops.
 */
export const LIMIT_WORDS = /rate.?limit|usage.?limit|quota|too many requests|\b429\b|credit balance|limit (?:reached|exceeded)|out of (?:credits|usage)|insufficient (?:credits?|funds|balance)|more credits|payment.?required|\b402\b|exceeded your [a-z ]{0,40}allowance/i;
/**
 * Words that mean the sign-in is missing or ended. Mirrored the same way.
 *
 * CODEX'S OWN SENTENCES FOR A SIGN-IN IT COULD NOT RENEW are five
 * (codex-rs/login/src/auth/manager.rs, at rust-v0.171.0), and all begin
 * "Your access token could not be refreshed". Three of them, a refresh token
 * "already used", one "revoked", and the one with no reason, end "Please
 * log out and sign in again", which is none of the phrases above: they read
 * as an `error`, so nothing was handed on, the box went on saying the
 * engine was signed in, and nobody was told to sign it in again. "Already
 * used" is what a sign-in becomes when a second copy of it renews.
 */
export const AUTH_WORDS = /not (?:logged|signed) in|unauthori[sz]ed|authentication|\b401\b|invalid (?:api key|token|credentials)|(?:token|credentials|session) (?:has |have )?expired|log ?in required|please (?:log|sign) in|access token could not be refreshed|log out and sign in again/i;

/** What each engine is started with, and the vault item it runs on. */
export const RUNS = Object.freeze({
  codex: Object.freeze({ protocol: 'codex', command: ['codex', 'app-server'], credential: 'codex', bin: 'FLEETWRIGHT_CODEX_BIN' }),
  // One row an ACP agent. Another agent that speaks the protocol is a row
  // here and a credential rule in `stage`, not a new adapter.
  opencode: Object.freeze({ protocol: 'acp', command: ['opencode', 'acp'], credential: 'copilot', bin: 'FLEETWRIGHT_OPENCODE_BIN' }),
});

/**
 * The providers OpenCode may bill to with a metered API key
 * (docs/api-engines.md): OpenCode's own name for each, which is the prefix
 * of a model and the entry its key is filed under; the member's vault item;
 * and the variable OpenCode's documentation names for the key, where it
 * names one. Mirrored from src/fleet/protocol/engines.js, which this file
 * cannot import; test/api-engines.test.js says if the two stop agreeing.
 */
export const API_PROVIDERS = Object.freeze({
  openrouter: Object.freeze({ opencode: 'openrouter', item: 'apikey:openrouter', env: 'OPENROUTER_API_KEY' }),
  'ai-gateway': Object.freeze({ opencode: 'vercel', item: 'apikey:ai-gateway', env: null }),
});

/** The API provider a model bills to, by its prefix, or null for one on a subscription. */
export function providerOf(engine, model) {
  if (engine !== 'opencode' || typeof model !== 'string') return null;
  const prefix = model.split('/')[0];
  return Object.values(API_PROVIDERS).find((p) => p.opencode === prefix) ?? null;
}

/**
 * WHAT THIS RUNNER WAS HANDED AND MUST NEVER SAY: an API key, a Copilot
 * token. An engine's error is its provider's own words, and a provider that
 * quotes a key back ("key sk-… is not valid") would otherwise put it in the
 * turn's detail, which goes to the coordinator, a notification and a screen.
 * Everything this runner says passes through `line`, so it is taken out
 * there.
 */
const withheld = new Set();

/**
 * Never say this value. One short enough to be an ordinary word is not kept, or it would be cut out of every sentence.
 *
 * A FILE IS WITHHELD BY WHAT IS IN IT. A Codex sign-in is a JSON file, and
 * what must not be said is each token inside it. Kept only whole, a file
 * with a space or a line break in it was not kept at all, and a line that
 * quoted its refresh token went to the pane and into a turn's detail. So
 * every string in a file this runner is handed is withheld on its own,
 * except one that is plainly a date (`last_refresh`), which is no secret
 * and would otherwise be cut out of ordinary output.
 */
export function withhold(value) {
  const v = typeof value === 'string' ? value.trim() : '';
  const one = (/** @type {string} */ text) => {
    if (text.length >= 12 && !/\s/.test(text)) withheld.add(text);
  };
  one(v);
  if (v[0] !== '{') return;
  const each = (/** @type {unknown} */ node, depth = 0) => {
    if (typeof node === 'string') {
      if (!/^\d{4}-\d\d-\d\dT/.test(node)) one(node.trim());
    } else if (node && typeof node === 'object' && depth < 6) {
      for (const inner of Object.values(node)) each(inner, depth + 1);
    }
  };
  try {
    each(JSON.parse(v));
  } catch { /* not a file of values: the whole text was looked at above */ }
}

/** The same text with every value this runner was handed taken out. */
export function hide(text) {
  let said = String(text);
  for (const secret of withheld) said = said.split(secret).join('[withheld]');
  return said;
}

/** One printable line, bounded. An engine's error is its own words and could be anything. */
export function line(value, max = 200) {
  if (value === undefined || value === null) return null;
  const s = hide(value).split('\n')[0].replace(/[^\x20-\x7e]/g, '').trim();
  return s ? s.slice(0, max) : null;
}

/**
 * Pass an engine's own error output on to this process's, a line at a time,
 * with anything this runner was handed taken out. It was inherited, which
 * put whatever the engine or its provider printed straight into the pane,
 * and the pane's last lines are what a handoff note copies into the
 * workspace and commits (docs/engines.md, "At a limit").
 */
function relayErrors(stream, to) {
  eachLine(stream, ERROR_LINE_MAX, (text, whole) => to(hide(whole ? `${text}\n` : text)), (text) => to(`${hide(text)} [the rest of this line was not kept]\n`));
}

/** The longest line of an engine's error output that is passed on, in characters. */
export const ERROR_LINE_MAX = 64 * 1024;
/** The longest message an engine may send, in characters. One longer ends the conversation with it. */
export const MESSAGE_MAX = 8 * 1024 * 1024;

/**
 * A stream, a line at a time, WITH A BOUND ON A LINE. Both things this
 * runner reads from an engine were held until a newline came, however long
 * that took: 200 MB with no newline in it took the runner to 895 MB, in a
 * container that shares its memory limit with the work. A line that passes
 * `max` is given to `tooLong` as far as it had got, once, and the rest of
 * it is dropped unread up to its newline.
 *
 * @param {any} stream
 * @param {number} max
 * @param {(text: string, whole: boolean) => void} line  `whole` is false for what was left when the stream ended
 * @param {(text: string) => void} tooLong
 * @param {() => void} [ended]
 */
export function eachLine(stream, max, line, tooLong, ended) {
  if (!stream || typeof stream.on !== 'function') return;
  let held = '';
  let dropping = false;
  stream.setEncoding?.('utf8');
  stream.on('data', (/** @type {unknown} */ chunk) => {
    let text = String(chunk);
    for (let at = text.indexOf('\n'); at >= 0; at = text.indexOf('\n')) {
      const head = text.slice(0, at);
      text = text.slice(at + 1);
      if (dropping) dropping = false;
      else if (held.length + head.length > max) tooLong((held + head).slice(0, max));
      else line(held + head, true);
      held = '';
    }
    if (dropping) return;
    if (held.length + text.length > max) {
      tooLong((held + text).slice(0, max));
      held = '';
      dropping = true;
    } else held += text;
  });
  let over = false;
  const end = () => {
    if (over) return;
    over = true;
    if (held && !dropping) line(held, false);
    held = '';
    ended?.();
  };
  stream.on('end', end);
  stream.on('close', end);
  stream.on('error', end);
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
   * @param {{ version?: string|null, maxMessage?: number }} [opts]
   */
  constructor(pipes, { version = '2.0', maxMessage = MESSAGE_MAX } = {}) {
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
    // A MESSAGE HAS A LONGEST LENGTH. One that passes it cannot be read, and
    // may have been the answer a turn is waiting on, so the conversation
    // ends there and says why: every request still waiting is settled with
    // it, and the runner starts the engine again for the next line.
    eachLine(
      pipes.stdout,
      maxMessage,
      (text) => this.#read(text),
      () => this.#end(`the engine sent one message longer than ${Math.round(maxMessage / 1024)} KiB, which is more than this runner reads`),
      () => this.#end('the engine closed its pipe'),
    );
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
    if (this.closed) return;
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
        const reason = reasonFromCodexError({ message: e?.message, codexErrorInfo: e?.data?.codexErrorInfo });
        // CODEX ASKS chatgpt.com ABOUT A CHATGPT SIGN-IN'S WORKSPACE before it
        // answers `account/read` (GET /backend-api/wham/accounts/check), and
        // says only this when it cannot. On a box behind an egress list
        // without that host every session ended on these four words, which
        // name nothing a person can change.
        if (reason === 'error' && /workspace routing discovery (?:failed|timed out)/i.test(String(e?.message ?? ''))) {
          return ended(engine, 'error', { detail: `Codex could not reach chatgpt.com to check its sign-in (${e.message}). This machine must be able to reach chatgpt.com` });
        }
        return ended(engine, reason, { detail: e?.message });
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

/**
 * An ACP error, as a reason. `-32000` is the protocol's own Authentication
 * required.
 *
 * WHAT OPENCODE SENDS, from its own source (packages/opencode/src/acp/error.ts
 * and service.ts, 1.19.6). A model it does not have is invalid params,
 * "model not found: <id>", with the provider and model as data: that is the
 * wrong model, and was read as an `error`, so a member whose OpenCode model
 * is not on the account's list was never handed on. A failed prompt is an
 * internal error whose message is the provider's own words and whose data
 * is `{ service, errorName }`: the name says a context that overflowed or a
 * sign-in the provider refused, and for anything else the words are all
 * there is. The data was searched for a limit's words and never held any.
 */
export function reasonFromAcpError(e) {
  const said = String(e?.message ?? '');
  const name = typeof e?.data?.errorName === 'string' ? e.data.errorName : '';
  if (e?.code === -32000 || name === 'ProviderAuthError' || AUTH_WORDS.test(said)) return 'auth';
  if (e?.code === -32602 && (typeof e?.data?.modelId === 'string' || /model not found/i.test(said))) return 'model';
  if (name === 'ContextOverflowError' || name === 'MessageOutputLengthError') return 'cut';
  if (LIMIT_WORDS.test(said)) return 'limit';
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
      /** The model the agent last said it was on, for an ending that is about the model. @type {string|null} */
      let on = null;
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
        on = says.now;
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
        const reason = reasonFromAcpError(e);
        // Refused the model: it is still on the one it said, and says so.
        return ended(engine, reason, { detail: e?.message, model: reason === 'model' ? on : null });
      }
    },

    /** @param {string} prompt */
    async turn(prompt) {
      usage = null;
      try {
        // No deadline: a turn takes as long as the work does. That includes
        // OpenCode's own waiting: it retries a rate limit itself, five
        // times, for as long as the provider's retry-after says
        // (packages/opencode/src/session/retry.ts), and only then answers
        // with the error. So a limit is reported when OpenCode gives up and
        // not when the provider first says so.
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
 * Where an engine keeps its sign-in inside an engine home, and what its own
 * process is started with so that it reads and renews it there
 * (docs/engines.md, "Credentials").
 *
 * `codex/` is Codex's whole home (`CODEX_HOME`). OpenCode takes its data
 * directory from `XDG_DATA_HOME`, so the engine home itself is that and
 * OpenCode's files are `opencode/` in it. FOR THE ENGINE'S PROCESS ALONE:
 * set for the session they would move every other tool's data in with a
 * member's sign-ins.
 *
 * @param {string} engine @param {string} engineHome
 * @returns {{ dir: string, file: string, env: Record<string, string> }|null}
 */
export function homePaths(engine, engineHome) {
  if (engine === 'codex') {
    const dir = path.join(engineHome, 'codex');
    return { dir, file: path.join(dir, 'auth.json'), env: { CODEX_HOME: dir } };
  }
  if (engine === 'opencode') {
    const dir = path.join(engineHome, 'opencode');
    return { dir, file: path.join(dir, 'auth.json'), env: { XDG_DATA_HOME: engineHome } };
  }
  return null;
}

/**
 * The sign-in an engine home holds for this engine, or null for none.
 *
 * WHAT COUNTS IS WHAT THE ENGINE WROTE THERE: for Codex a file with a
 * refresh token in it, for OpenCode a `github-copilot` entry with a token.
 * An empty file, one that does not parse, and an OpenCode file that holds
 * only an API key are none, and the member's pasted item is asked for as
 * before. Whether a sign-in found here still works is the engine's to say,
 * in the check before a turn.
 *
 * @param {string} engine @param {string} engineHome
 * @returns {{ file: string, text: string }|null}
 */
export function signedInAt(engine, engineHome) {
  const at = homePaths(engine, engineHome);
  if (!at) return null;
  try {
    const text = readFileSync(at.file, 'utf8');
    const held = JSON.parse(text);
    if (!held || typeof held !== 'object') return null;
    const token = engine === 'codex' ? held.tokens?.refresh_token : (held['github-copilot']?.refresh || held['github-copilot']?.access);
    return typeof token === 'string' && token ? { file: at.file, text } : null;
  } catch {
    return null;
  }
}

/**
 * Put the engine's credential where the engine reads it, from the member's
 * vault item as the socket handed it over. Returns what to watch for
 * changes: Codex renews its own tokens into the file, and the renewed file
 * is handed back to the box, which is the one machine that holds it.
 *
 * INTO THE ENGINE HOME, when the box mounted one, so there is one place an
 * engine reads its sign-in from, and the member's next session here finds
 * it. OpenCode's file there may already hold another provider's entry (a
 * key beside a Copilot sign-in, or the other way round), so an entry is
 * added to what is there and never written over it.
 *
 * @param {string} engine @param {string} value @param {string} home
 * @param {{ opencode: string, env: string|null }|null} [provider]  the API provider the model bills to, when it bills to one
 * @param {string|null} [engineHome]  the member's engine home on this machine, when the box mounted one
 * @returns {{ ok: true, file: string|null, env?: Record<string, string> } | { ok: false, text: string }}
 */
export function stage(engine, value, home, provider = null, engineHome = null) {
  const at = engineHome ? homePaths(engine, engineHome) : null;
  try {
    if (engine === 'codex') {
      const dir = at?.dir ?? (process.env.CODEX_HOME || path.join(home, '.codex'));
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
      const dir = at?.dir ?? path.join(process.env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'opencode');
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      /** What the file holds already, in an engine home. A file that does not read is replaced. @type {Record<string, unknown>} */
      let there = {};
      if (at) {
        try {
          const held = JSON.parse(readFileSync(at.file, 'utf8'));
          if (held && typeof held === 'object' && !Array.isArray(held)) there = held;
        } catch { /* none yet, or not a file of entries */ }
      }
      // AN API KEY, filed under OpenCode's own name for the provider, in the
      // shape it keeps a key in. And, where OpenCode's documentation names a
      // variable for it, in that variable for the engine's process alone:
      // a newer OpenCode reads this file once, into a store of its own, and
      // not again where that store already has an entry for the provider.
      if (provider) {
        writeFileSync(path.join(dir, 'auth.json'), `${JSON.stringify({ ...there, [provider.opencode]: { type: 'api', key: value.trim() } })}\n`, { mode: 0o600 });
        return { ok: true, file: null, ...(provider.env ? { env: { [provider.env]: value.trim() } } : {}) };
      }
      writeFileSync(path.join(dir, 'auth.json'), `${JSON.stringify({ ...there, 'github-copilot': { type: 'oauth', refresh: value.trim(), access: '', expires: 0 } })}\n`, { mode: 0o600 });
      return { ok: true, file: null };
    }
    return { ok: false, text: `no credential rule for ${engine}` };
  } catch (e) {
    return { ok: false, text: `could not write ${engine}’s sign-in: ${e?.message ?? e}` };
  }
}

/**
 * Where OpenCode reads a machine's own settings, which override a person's
 * and a project's (https://opencode.ai/docs/config/, "Locations": "The
 * system config overrides all of them").
 */
export const OPENCODE_SYSTEM_DIR = '/etc/opencode';

/**
 * The settings that make OpenCode ask before it acts
 * (https://opencode.ai/docs/permissions/). Everything asks, and a later
 * OpenCode's new tool asks too, except looking: reading a file, with the
 * `.env` rules OpenCode's own defaults have, and the two searches.
 */
export const OPENCODE_ASKS = Object.freeze({
  $schema: 'https://opencode.ai/config.json',
  permission: Object.freeze({
    '*': 'ask',
    read: Object.freeze({ '*': 'allow', '*.env': 'deny', '*.env.*': 'deny', '*.env.example': 'allow' }),
    glob: 'allow',
    grep: 'allow',
  }),
});

/**
 * Make an engine ask before it acts, in a session that asks first.
 *
 * OPENCODE DOES NOT ASK UNLESS IT IS TOLD TO: its permissions default to
 * allow. The runner declines what an engine asks to do in a `safe` session,
 * and OpenCode never asked, so a `safe` session on OpenCode edited files and
 * ran commands with nobody declining anything. So it is told, in the one
 * place a workspace cannot answer back from: a project's own
 * `opencode.json` overrides a person's settings and not the machine's, and
 * the workspace is the session's to write.
 *
 * NOT WRITTEN IS NOT STARTED. A `safe` session whose engine could not be
 * told to ask is one that would not ask.
 *
 * Codex needs nothing here: it is told on `thread/start`.
 *
 * @param {string} engine @param {string} mode @param {string} dir  where the engine reads its machine's settings
 * @returns {{ ok: true } | { ok: false, text: string }}
 */
export function askFirst(engine, mode, dir) {
  if (engine !== 'opencode' || mode === 'dangerous') return { ok: true };
  try {
    mkdirSync(dir, { recursive: true, mode: 0o755 });
    writeFileSync(path.join(dir, 'opencode.json'), `${JSON.stringify(OPENCODE_ASKS, null, 2)}\n`, { mode: 0o644 });
    return { ok: true };
  } catch (e) {
    return { ok: false, text: `could not tell OpenCode to ask before it acts, so it was not started: ${e?.message ?? e}` };
  }
}

/**
 * Where an engine that is not signed in is signed in again. In plain
 * characters: `line` keeps nothing else.
 */
export const SIGN_IN_AGAIN = "To sign it in: this member's Credentials in the Fleetwright app, Sign in on a machine.";

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
 * @param {{ socket?: string, home?: string, cwd?: string, out?: (text: string) => void, err?: (text: string) => void, stdin?: import('node:stream').Readable, spawnEngine?: Function, env?: Record<string, string|undefined>, systemDir?: string, signals?: { once: (name: string, then: () => void) => any }, watchMs?: number }} [io]
 *   `systemDir` is where OpenCode reads its machine's settings; `signals` is what says the session is being stopped; `watchMs` how often a sign-in file is looked at for a renewal
 */
export async function run(args, io = {}) {
  const socket = io.socket ?? SOCKET;
  const home = io.home ?? homedir();
  const cwd = io.cwd ?? process.cwd();
  const env = io.env ?? process.env;
  const systemDir = io.systemDir ?? env.FLEETWRIGHT_OPENCODE_SYSTEM_DIR ?? OPENCODE_SYSTEM_DIR;
  const write = io.out ?? ((text) => process.stdout.write(text));
  // EVERYTHING THE PANE IS SHOWN PASSES HERE, the agent's own words included:
  // an agent that echoes its key is as much a leak as a provider that does.
  const out = (/** @type {string} */ text) => write(hide(text));
  const note = (/** @type {string} */ text) => out(`\n[fleetwright] ${text}\n`);
  // AN ENGINE THAT IS NOT SIGNED IN SAYS WHERE IT IS SIGNED IN AGAIN, in the
  // turn's detail, which is what a person reads on the session: the engine's
  // own words first, cut to leave room for it. Not for an engine on a key:
  // a key is kept or turned on, and nothing signs it in.
  const report = (/** @type {any} */ turn) => {
    const told = turn.reason === 'auth' && !providerOf(args.engine, args.model) ? { ...turn, detail: line(`${turn.detail ? `${String(turn.detail).slice(0, 108).replace(/[.\s]+$/, '')}. ` : ''}${SIGN_IN_AGAIN}`) } : turn;
    return post(socket, '/internal/session-event', { event: 'TurnEnded', detail: told.reason, turn: told });
  };
  const spec = RUNS[args.engine];
  if (!spec) {
    note(`${line(args.engine, 40) ?? 'No engine'} is not an engine this runner speaks to.`);
    return 2;
  }

  /** One attempt at being ready: the credential, the engine's server, the two checks. */
  // WHAT THIS ENGINE RUNS ON: its own sign-in, or the key of the provider
  // its model names (docs/api-engines.md).
  const provider = providerOf(args.engine, args.model);
  const item = provider ? provider.item : spec.credential;
  // THE MEMBER'S ENGINE HOME ON THIS MACHINE, when the box mounted one
  // (docs/engines.md, "Credentials"). The engine is started reading it.
  const engineHome = typeof env.FLEETWRIGHT_ENGINE_HOME === 'string' && env.FLEETWRIGHT_ENGINE_HOME ? env.FLEETWRIGHT_ENGINE_HOME : null;
  const homeEnv = engineHome ? homePaths(args.engine, engineHome)?.env ?? {} : {};
  const open = async () => {
    // A SIGN-IN MADE ON THIS MACHINE IS USED FIRST, AND NOTHING IS ASKED FOR.
    // The engine renews it where it is, so there is nothing to stage and
    // nothing to hand back. A key is not a sign-in and is asked for every
    // time, as it was.
    const here = engineHome && !provider ? signedInAt(args.engine, engineHome) : null;
    /** @type {{ ok: true, file: string|null, env?: Record<string, string> } | { ok: false, text: string }} */
    let staged;
    /** @type {string|null} */
    let was = null;
    if (here) {
      // As much this runner's to keep quiet as one it was handed.
      withhold(here.text);
      staged = { ok: true, file: here.file };
      was = here.text;
    } else {
      const got = await post(socket, '/internal/engine-credential', { kind: item });
      if (!got?.ok || typeof got.value !== 'string' || !got.value) {
        return { failed: ended(args.engine, 'auth', { detail: got?.message ?? `this machine holds no ${provider ? 'key' : `${spec.credential} sign-in`} for this member` }) };
      }
      withhold(got.value);
      staged = stage(args.engine, got.value, home, provider, engineHome);
      if (staged.ok && staged.file) was = got.value;
    }
    if (!staged.ok) return { failed: ended(args.engine, 'error', { detail: staged.text }) };
    const asks = askFirst(args.engine, args.mode, systemDir);
    if (!asks.ok) return { failed: ended(args.engine, 'error', { detail: asks.text }) };
    const command = env[spec.bin] ? [env[spec.bin]] : [spec.command[0]];
    let child;
    try {
      // The key's variable, when there is one, for the engine's process and nothing else of this session's.
      child = (io.spawnEngine ?? spawn)(command[0], spec.command.slice(1), { cwd, env: staged.env || engineHome ? { ...env, ...homeEnv, ...(staged.env ?? {}) } : env, stdio: ['pipe', 'pipe', 'pipe'] });
      relayErrors(child.stderr, io.err ?? ((s) => process.stderr.write(s)));
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
    // `handBack` is whether a renewed file goes back to the box: only for the
    // session that was handed the box's copy.
    return { adapter, child, peer, file: staged.file, was, handBack: !here };
  };

  /**
   * Hand a renewed sign-in back to the box, when the engine rewrote its file.
   *
   * AS SOON AS IT CHANGES, and again as the session is stopped. A renewal
   * ends the copy the box holds, and it was handed back only when a turn
   * ended: a session stopped in the middle of the turn that renewed left
   * the box holding a sign-in that had already been used up, and the next
   * session on this machine signed out. One at a time, so a look that finds
   * the file changed while the last is still being sent does not send the
   * same file twice.
   *
   * A SIGN-IN MADE ON THIS MACHINE IS NOT HANDED BACK: the box holds no copy
   * of it to keep up. Its file is still looked at, because what the engine
   * renews into it is to be kept as quiet as what it replaced.
   */
  let keeping = Promise.resolve();
  const keep = (/** @type {any} */ live) => {
    keeping = keeping.then(async () => {
      if (!live?.file) return;
      try {
        const now = readFileSync(live.file, 'utf8');
        if (now && now !== live.was) {
          // What Codex wrote is as much this runner's to keep quiet as what it was handed.
          withhold(now);
          if (!live.handBack) {
            live.was = now;
            return;
          }
          const kept = await post(socket, '/internal/engine-credential', { kind: spec.credential, value: now });
          if (kept?.ok) live.was = now;
        }
      } catch { /* gone or unreadable: the box keeps what it had */ }
    });
    return keeping;
  };
  /**
   * Look at a live engine's sign-in file for a renewal, for as long as it is
   * live. By looking, every couple of seconds, and not by being told: Codex
   * replaces its file, so a watch on the file it replaced hears nothing
   * more, and a renewal made while the engine was still opening happened
   * before any watch could have been set. The first look is at once.
   */
  const watch = (/** @type {any} */ live) => {
    if (!live.file) return;
    let seen = '';
    const look = () => {
      try {
        const at = statSync(live.file);
        const now = `${at.mtimeMs}:${at.size}:${at.ino}`;
        if (now === seen) return;
        seen = now;
        void keep(live);
      } catch { /* gone: nothing to hand back */ }
    };
    look();
    live.watching = setInterval(look, io.watchMs ?? 2000);
    live.watching.unref?.();
  };
  const unwatch = (/** @type {any} */ live) => {
    if (live?.watching) clearInterval(live.watching);
  };

  let live = null;
  // THE SESSION BEING STOPPED is tmux closing the pane or the container
  // being told to end, and arrives as a signal. It used to exit at once,
  // mid-turn or not. Now whatever was waited on is given up, the sign-in is
  // handed back if it changed, and then the runner ends.
  /** @type {Promise<'stopped'>} */
  const stopped = new Promise((resolve) => {
    for (const name of ['SIGTERM', 'SIGINT', 'SIGHUP']) io.signals?.once(name, () => resolve('stopped'));
  });
  const leave = async () => {
    unwatch(live);
    await keep(live);
    live?.child.kill?.();
    return 0;
  };
  let prompt = args.prompt;
  const typed = createInterface({ input: io.stdin ?? process.stdin });
  const lines = typed[Symbol.asyncIterator]();
  for (;;) {
    if (prompt.trim()) {
      await post(socket, '/internal/session-event', { event: 'UserPromptSubmit' });
      if (!live) {
        const opened = await Promise.race([open(), stopped]);
        if (opened === 'stopped') return leave();
        if (opened.failed) {
          note(`${args.engine} did not start a turn: ${opened.failed.reason}${opened.failed.detail ? ` (${opened.failed.detail})` : ''}.`);
          await report(opened.failed);
        } else {
          live = opened;
          watch(live);
        }
      }
      if (live) {
        const turn = await Promise.race([live.adapter.turn(prompt), stopped]);
        if (turn === 'stopped') return leave();
        await keep(live);
        if (turn.reason !== 'done') note(`${args.engine}’s turn ended: ${turn.reason}${turn.detail ? ` (${turn.detail})` : ''}.`);
        await report(turn);
        // A pipe that closed is an engine that is gone, and one whose
        // conversation was ended here (a message too long to read) is of no
        // more use: the next line typed starts it again.
        if ((live.child.exitCode !== null && live.child.exitCode !== undefined) || live.peer.closed) {
          unwatch(live);
          live.child.kill?.();
          live = null;
        }
      }
    }
    out('\n> ');
    const next = await Promise.race([lines.next(), stopped]);
    if (next === 'stopped' || next.done) break;
    prompt = String(next.value ?? '');
  }
  return leave();
}

// ── Signing in on the machine ───────────────────────────────────────────────
//
// `fleetwright-engine --signin <engine>` and `--signout <engine>`: what a box
// runs, in a short container with one member's engine home mounted and no
// session's socket, when a custodian asks it to sign an engine in
// (docs/engines.md, "Signing in on the machine"). It asks the engine itself
// for a device code, and the engine writes its own sign-in into the home.
// This file never speaks to OpenAI or GitHub and holds no client id.
//
// WHAT IT PRINTS IS TWO LINES OF JSON, AND NOTHING ELSE. The first is the
// page to open and the code to enter, as soon as the engine gives them:
//
//   {"signin":"code","engine":"codex","url":"https://…","code":"ABCD-EFGH","expiresInMinutes":15}
//
// The second is how it ended, and for Codex who is signed in, as Codex says:
//
//   {"signin":"done","engine":"codex","state":"signed_in","who":{"email":"…","plan":"plus"}}
//
// `state` is `signed_in`, `expired`, `failed`, `cancelled`, or for a sign
// out `signed_out`. A failure carries the engine's own sentence as `detail`,
// and `why: "device_code_off"` when Codex says device code is not enabled.
//
// NO TOKEN, EVER. The engine's sign-in file is read only to withhold what is
// in it from these two lines. What the engine prints on its error output is
// not passed on at all here, as it is in a session: before a sign-in exists
// there is nothing of it to take out, and afterwards nothing is said but the
// second line.

/** How long a device code lasts, in minutes. Codex's own bound (codex-rs/login/src/device_code_auth.rs); GitHub's codes last the same. */
export const SIGNIN_MINUTES = 15;

/** OpenCode's name for the provider a subscription sign-in is to. */
const OPENCODE_SIGNIN_PROVIDER = 'github-copilot';

/**
 * One request to OpenCode's own server on loopback, as JSON.
 *
 * @param {string} base  `http://127.0.0.1:<port>`
 * @param {string} method @param {string} pathname @param {unknown} body
 * @param {string} authorization  the Basic header for the password this run made
 * @param {number} timeoutMs  0 waits for as long as it takes
 * @returns {{ answer: Promise<{ status: number, body: any }>, abort: () => void }}
 */
export function askServer(base, method, pathname, body, authorization, timeoutMs) {
  /** @type {import('node:http').ClientRequest|null} */
  let req = null;
  const answer = new Promise((resolve, reject) => {
    const data = body === undefined ? '' : JSON.stringify(body);
    const url = new URL(pathname, base);
    req = request({
      host: url.hostname, port: url.port, path: url.pathname, method,
      // A CONNECTION OF ITS OWN FOR EACH REQUEST. Node's default agent keeps
      // a connection for the next request and gives it five idle seconds,
      // four once OpenCode has answered `Keep-Alive: timeout=5`, which its
      // server does. The request that waits for GitHub was sent on the
      // connection the one before it had used, nothing moves on it while
      // OpenCode asks, and so it was cut four seconds after the code was
      // shown: every OpenCode sign-in ended `failed` before anybody could
      // have typed the code. With no agent there is no kept connection and
      // no timeout but the one asked for below.
      agent: false,
      headers: { authorization, accept: 'application/json', ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}) },
      ...(timeoutMs ? { timeout: timeoutMs } : {}),
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => {
        if (text.length < 64 * 1024) text += c;
      });
      res.on('end', () => {
        let parsed = null;
        try {
          parsed = JSON.parse(text);
        } catch { /* not JSON: the status is the answer */ }
        resolve({ status: res.statusCode ?? 0, body: parsed });
      });
    });
    req.on('error', (e) => reject(e));
    req.on('timeout', () => req?.destroy(new Error(`OpenCode did not answer ${pathname} in ${Math.round(timeoutMs / 1000)}s`)));
    req.end(data);
  });
  return { answer, abort: () => req?.destroy(new Error('given up')) };
}

/**
 * Sign one engine in, or out, in this container's engine home.
 *
 * @param {{ engine: string, out?: boolean }} args  `out` is a sign out
 * @param {{ env?: Record<string, string|undefined>, out?: (text: string) => void, spawnEngine?: Function, signals?: { once: (name: string, then: () => void) => any }, capMs?: number, startMs?: number }} [io]
 *   `capMs` is how long a code is waited on; `startMs` how long the engine has to come up and answer
 * @returns {Promise<number>} the exit code: 0 when it said how it ended
 */
export async function signin(args, io = {}) {
  const env = io.env ?? process.env;
  const write = io.out ?? ((text) => process.stdout.write(text));
  const capMs = io.capMs ?? SIGNIN_MINUTES * 60_000;
  const startMs = io.startMs ?? 30_000;
  const engine = String(args.engine ?? '');
  const spec = RUNS[engine];
  const engineHome = typeof env.FLEETWRIGHT_ENGINE_HOME === 'string' && env.FLEETWRIGHT_ENGINE_HOME ? env.FLEETWRIGHT_ENGINE_HOME : null;
  const at = engineHome && spec ? homePaths(engine, engineHome) : null;
  /** Everything said passes here, with whatever the engine home holds taken out first. */
  const say = (/** @type {Record<string, unknown>} */ what) => {
    if (at) {
      try {
        withhold(readFileSync(at.file, 'utf8'));
      } catch { /* no sign-in there: nothing of one to take out */ }
    }
    write(`${hide(JSON.stringify({ engine, ...what }))}\n`);
  };
  const done = (/** @type {string} */ state, /** @type {Record<string, unknown>} */ extra = {}) => {
    say({ signin: 'done', state, ...extra });
    return 0;
  };
  const failed = (/** @type {unknown} */ detail, /** @type {Record<string, unknown>} */ extra = {}) => done('failed', { detail: line(detail) ?? 'the engine gave no reason', ...extra });
  if (!spec) return failed(`${line(engine, 40) ?? 'that'} is not an engine this runner signs in`);
  if (!at) return failed('this container was given no engine home to keep a sign-in in');
  try {
    mkdirSync(at.dir, { recursive: true, mode: 0o700 });
  } catch (e) {
    return failed(`the engine home could not be written: ${e?.message ?? e}`);
  }

  /** @type {Promise<'stopped'>} */
  const stopped = new Promise((resolve) => {
    for (const name of ['SIGTERM', 'SIGINT', 'SIGHUP']) io.signals?.once(name, () => resolve('stopped'));
  });
  /** @type {any} */
  let capTimer = null;
  /** @type {Promise<'cap'>} */
  const cap = new Promise((resolve) => {
    capTimer = setTimeout(() => resolve('cap'), capMs);
  });
  const command = env[spec.bin] ? String(env[spec.bin]) : spec.command[0];
  /** @type {any} */
  let child = null;
  /** @type {string|null} */
  let spawnError = null;
  const start = (/** @type {string[]} */ argv, /** @type {Record<string, string>} */ more) => {
    child = (io.spawnEngine ?? spawn)(command, argv, { env: { ...env, ...at.env, ...more }, stdio: ['pipe', 'pipe', 'pipe'] });
    child.on?.('error', (e) => {
      spawnError = e?.code === 'ENOENT' ? `${command} is not installed in this machine's session image` : String(e?.message ?? e);
    });
    // NOT PASSED ON, and drained so the engine never blocks on a full pipe.
    child.stderr?.resume?.();
  };
  const leave = () => {
    clearTimeout(capTimer);
    child?.kill?.();
  };

  try {
    return engine === 'codex' ? await codex() : await opencode();
  } catch (e) {
    return failed(spawnError ?? e?.message ?? e);
  } finally {
    leave();
  }

  // Codex, through the app server a session's turns go through
  // (codex-rs/app-server-protocol, v2, at rust-v0.171.0).
  async function codex() {
    start(['app-server'], {});
    const peer = new Peer(child, { version: null });
    /** @type {Promise<'closed'>} */
    const closed = new Promise((resolve) => {
      peer.onClose = () => resolve('closed');
    });
    await peer.request('initialize', { clientInfo: { name: 'fleetwright', title: 'Fleetwright', version: '1' }, capabilities: null }, startMs);
    peer.notify('initialized');
    if (args.out) {
      // `account/logout` removes the file and answers an empty object.
      await peer.request('account/logout', undefined, startMs);
      return done('signed_out');
    }
    // HOW IT ENDED arrives as a notice, and can arrive before the answer that
    // says which sign-in is this one, so every one is kept until that is known.
    /** @type {string|null} */
    let loginId = null;
    /** @type {any[]} */
    const heard = [];
    /** @type {(params: any) => void} */
    let settle = () => {};
    /** @type {Promise<any>} */
    const completed = new Promise((resolve) => {
      settle = resolve;
    });
    const mine = (/** @type {any} */ params) => loginId !== null && (params?.loginId === loginId || params?.loginId === null || params?.loginId === undefined);
    peer.onNotification = (method, params) => {
      if (method !== 'account/login/completed') return;
      if (loginId === null) heard.push(params);
      else if (mine(params)) settle(params);
    };
    let begun;
    try {
      begun = await peer.request('account/login/start', { type: 'chatgptDeviceCode' }, startMs);
    } catch (e) {
      // Codex's own words for an account or workspace with device code turned
      // off (login/src/device_code_auth.rs, a 404 from the issuer).
      const off = /device code login is not enabled/i.test(String(e?.message ?? ''));
      return failed(e?.message, off ? { why: 'device_code_off' } : {});
    }
    const url = line(begun?.verificationUrl, 300);
    const code = line(begun?.userCode, 40);
    if (begun?.type !== 'chatgptDeviceCode' || typeof begun?.loginId !== 'string' || !url || !/^https:\/\//.test(url) || !code) {
      return failed('Codex answered the sign-in with no page and code to give');
    }
    loginId = begun.loginId;
    for (const params of heard) if (mine(params)) settle(params);
    say({ signin: 'code', url, code, expiresInMinutes: Math.round(capMs / 60_000) });
    const how = await Promise.race([completed, closed, cap, stopped]);
    if (how === 'stopped' || how === 'cap') {
      // Told, so Codex stops asking OpenAI for a sign-in nobody is waiting on.
      await peer.request('account/login/cancel', { loginId }, 3000).catch(() => {});
      return done(how === 'cap' ? 'expired' : 'cancelled');
    }
    if (how === 'closed') return failed(spawnError ?? 'Codex stopped before it said how the sign-in ended');
    if (how?.success !== true) {
      // Codex gives up by itself after the same 15 minutes, in these words.
      if (/timed out/i.test(String(how?.error ?? ''))) return done('expired');
      return failed(how?.error ?? 'Codex said the sign-in did not complete');
    }
    // WHO, as Codex says: an address and a plan. Never anything from the file.
    const read = await peer.request('account/read', { refreshToken: false }, startMs).catch(() => null);
    const account = read?.account?.type === 'chatgpt' ? read.account : null;
    return done('signed_in', { who: account ? { email: line(account.email, 120), plan: line(account.planType, 40) } : null });
  }

  // OpenCode, through its own server on loopback: `opencode acp` has no
  // sign-in, and its command-line login needs a terminal. The two calls must
  // reach one process, which holds what is pending in memory
  // (packages/opencode/src/provider/auth.ts, at v1.19.6).
  async function opencode() {
    // A PASSWORD FOR THIS ONE RUN, so the server answers this runner and
    // nothing else in the container (server/auth.ts; the user is `opencode`).
    const password = randomBytes(24).toString('hex');
    withhold(password);
    const authorization = `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`;
    withhold(authorization.slice('Basic '.length));
    start(['serve', '--hostname', '127.0.0.1', '--port', '0'], { OPENCODE_SERVER_PASSWORD: password });
    // It says where it listens on its own output (cli/cmd/serve.ts).
    /** @type {Promise<string|null>} */
    const listening = new Promise((resolve) => {
      eachLine(child.stdout, 4096, (text) => {
        const m = /listening on (http:\/\/127\.0\.0\.1:\d{1,5})\b/.exec(text);
        if (m) resolve(m[1]);
      }, () => {}, () => resolve(null));
    });
    /** @type {Promise<'closed'>} */
    const closed = new Promise((resolve) => {
      child.on?.('exit', () => resolve('closed'));
    });
    /** @type {any} */
    let startTimer = null;
    const base = await Promise.race([listening, new Promise((resolve) => {
      startTimer = setTimeout(() => resolve(null), startMs);
    })]);
    clearTimeout(startTimer);
    if (!base) return failed(spawnError ?? 'OpenCode’s server did not start');
    if (args.out) {
      // OpenCode's own route for removing a provider's entry (auth.remove).
      const gone = await askServer(base, 'DELETE', `/auth/${OPENCODE_SIGNIN_PROVIDER}`, undefined, authorization, startMs).answer;
      return gone.status === 200 ? done('signed_out') : failed(`OpenCode would not remove its sign-in (HTTP ${gone.status})`);
    }
    const asked = await askServer(base, 'POST', `/provider/${OPENCODE_SIGNIN_PROVIDER}/oauth/authorize`, { method: 0, inputs: { deploymentType: 'github.com' } }, authorization, startMs).answer;
    const url = line(asked.body?.url, 300);
    // "Enter code: XXXX-XXXX" (plugin/github-copilot/copilot.ts).
    const code = /code:\s*([A-Za-z0-9-]{4,40})\s*$/.exec(String(asked.body?.instructions ?? ''))?.[1] ?? null;
    if (asked.status !== 200 || asked.body?.method !== 'auto' || !url || !/^https:\/\//.test(url) || !code) {
      const name = line(asked.body?.name, 60);
      return failed(asked.status === 200 ? 'OpenCode answered the sign-in with no page and code to give' : `OpenCode refused to start the sign-in (${name ?? `HTTP ${asked.status}`})`);
    }
    say({ signin: 'code', url, code, expiresInMinutes: Math.round(capMs / 60_000) });
    // Held open while OpenCode asks GitHub, for as long as that takes.
    const waiting = askServer(base, 'POST', `/provider/${OPENCODE_SIGNIN_PROVIDER}/oauth/callback`, { method: 0 }, authorization, 0);
    const how = await Promise.race([waiting.answer.catch((e) => ({ status: 0, body: null, lost: String(e?.message ?? e) })), closed, cap, stopped]);
    if (how === 'stopped' || how === 'cap') {
      waiting.abort();
      return done(how === 'cap' ? 'expired' : 'cancelled');
    }
    if (how === 'closed') return failed(spawnError ?? 'OpenCode stopped before it said how the sign-in ended');
    if (how.status === 200 && how.body === true) return done('signed_in', { who: null });
    // OpenCode says only that it failed: GitHub's reason, a code that ran out
    // or a request somebody declined, does not reach its answer.
    const name = line(how.body?.name, 60);
    return failed(name
      ? `OpenCode did not complete the sign-in (${name}). It does not pass on GitHub's reason: the code may have run out, or the request was declined`
      : `OpenCode did not complete the sign-in (${/** @type {any} */ (how).lost ?? `HTTP ${how.status}`})`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  if (argv[0] === '--signin' || argv[0] === '--signout') {
    // A sign-in, not a session: no socket, no pane, two lines of JSON. A
    // signal is the box cancelling it, and is `signin`'s to hear.
    signin({ engine: String(argv[1] ?? ''), out: argv[0] === '--signout' }, { signals: process }).then((code) => process.exit(code), (e) => {
      process.stdout.write(`${JSON.stringify({ signin: 'done', state: 'failed', detail: line(e?.message ?? e) })}\n`);
      process.exit(1);
    });
  } else {
    // The signals that stop a session are `run`'s to hear: it hands a renewed
    // sign-in back before it ends.
    run(parseArgs(argv), { signals: process }).then((code) => process.exit(code), (e) => {
      process.stdout.write(`\n[fleetwright] the engine runner stopped: ${e?.message ?? e}\n`);
      process.exit(1);
    });
  }
}
