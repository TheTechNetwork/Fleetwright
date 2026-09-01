// The fleet as an MCP server.
//
// "An MCP server is a thin adapter over /api/intent, not new architecture" —
// ROADMAP, and it turned out to be true. The intent protocol was designed as a
// fixed set of typed verbs with structured replies and refusals that name a
// reason, which is the same shape MCP asks for, so the tools are GENERATED from
// the verb registry rather than written out (see tools.js).
//
// WHAT THIS IS, PRECISELY. A member of the fleet, holding one device credential,
// with exactly that person's visibility. Not an admin channel and not a second
// authority: the coordinator decides what a caller may do and has not changed.
// If the credential belongs to somebody who can see three sessions, so does the
// agent using this.
//
// NO SDK. MCP over stdio is JSON-RPC 2.0 with three methods that matter, and
// this repository ships one runtime dependency on purpose. A dependency is
// worth adding when it does something hard; framing `{"jsonrpc":"2.0"}` is not
// hard, and the protocol is small enough to read in one sitting.
//
// Framing is newline-delimited JSON, which is what the stdio transport uses.

import { toolsFor, DEFAULT_DENY } from './tools.js';

/** MCP revision this speaks. Echoed back at initialize. */
const PROTOCOL = '2024-11-05';

/**
 * @typedef {object} Options
 * @property {string} coordinator   origin of the fleet
 * @property {string} credential    a device token (fwk_…)
 * @property {string[]|null} [allow] verbs to expose beyond the safe set
 * @property {number} [budgetMinutes] how long work here is expected to take
 * @property {typeof fetch} [fetch]
 * @property {(line: string) => void} [write]
 * @property {(m: string) => void} [log]
 * @property {() => number} [now]
 * @property {(ms: number) => Promise<void>} [sleep]
 */

export class McpServer {
  /** @param {Options} opts */
  constructor({ coordinator, credential, allow = null, budgetMinutes = 15, fetch: doFetch = fetch, write, log = () => {}, now = () => Date.now(), sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms)) }) {
    this.coordinator = String(coordinator || '').replace(/\/+$/, '');
    this.credential = credential;
    this.budgetMinutes = budgetMinutes;
    this.tools = toolsFor({ allow, budgetMinutes });
    // SESSIONS THIS SERVER STARTED. `stop` is withheld in general — ending work
    // that is not yours is not something an agent should reach for unasked —
    // but an agent that STARTED a session must be able to end it, or the
    // instructions below are asking for something it cannot do.
    /** @type {Set<string>} */
    this.started = new Set();
    this.fetch = doFetch;
    // Every reply goes through here so the transport is injectable and the
    // whole server is testable without a pipe.
    this.write = write || ((line) => process.stdout.write(`${line}\n`));
    this.log = log;
    // Injected so a test can wait without waiting. A blocking tool tested with
    // real time is a test nobody runs.
    this.now = now;
    this.sleep = sleep;
  }

  /**
   * Wait until a session needs a person, finishes, or the clock runs out.
   *
   * ASKED DIRECTLY: "should mcp be able to notify llm a task needs help or a
   * task is complete?" — and the honest answer is that an MCP server can send
   * notifications but cannot reliably WAKE a model. A notification arrives on
   * the transport; whether it reaches the model depends on the client, and a
   * model that is not currently in a turn is not listening. Building on that
   * would produce a feature that works in one client and silently does nothing
   * in the next.
   *
   * A TOOL THAT BLOCKS NEEDS NO WAKING. The agent calls it and the return value
   * IS the notification. It works in every client, because it is just a tool
   * call that takes a while.
   *
   * The fleet already knows both facts and has for a long time — the host
   * watcher detects a session blocked on a dialog, and both events are already
   * considered worth waking a PERSON for (core.js NOTIFIABLE). This carries the
   * same two signals to the other kind of caller.
   *
   * Polling, deliberately, and slowly. The alternative is a streaming endpoint
   * on the coordinator, which is a real thing to build and to keep alive
   * through a Worker; asking every few seconds is unglamorous and cannot
   * silently stop working.
   *
   * @param {Record<string, any>} params
   * @param {string|null} host
   */
  async #await(params, host) {
    const name = String(params.name || '');
    const seconds = Math.min(900, Math.max(5, Number(params.seconds) || 300));
    const deadline = this.now() + seconds * 1000;

    for (;;) {
      /** @type {any} */
      let reply;
      try {
        reply = await this.#intent('status', { name }, host);
      } catch (e) {
        return this.#text(`Could not reach the fleet: ${/** @type {Error} */ (e).message}`, true);
      }
      if (reply?.ok === false) return this.#text(String(reply.text ?? 'refused'), true);

      const session = reply?.session ?? reply;
      const status = String(session?.status ?? '');
      // NEEDS A PERSON. The one state where waiting longer changes nothing:
      // something is blocking on an answer, and nobody is going to give it.
      if (session?.awaiting) {
        return this.#text(
          `${name} is waiting for an answer:\n${String(session.detail ?? session.text ?? '').trim()}\n\n` +
            'It will not go further until somebody answers. Read it with fleet_read_log if you need the whole story.',
        );
      }
      if (status === 'stopped' || status === 'error') {
        return this.#text(
          `${name} has ${status === 'error' ? 'failed' : 'ended'}. ` +
            'Its output is still readable with fleet_read_log — that survives the session, unlike the pane.',
          status === 'error',
        );
      }
      if (this.now() >= deadline) {
        // NOT AN ERROR. Still running after the time asked for is an answer,
        // and calling it a failure would push an agent into stopping work that
        // is going fine.
        return this.#text(
          `${name} is still running after ${seconds}s. That is not a failure — it may just be slow. ` +
            'Wait again, read it with fleet_read_log, or stop it if you have what you need.',
        );
      }
      await this.sleep(Math.min(5000, Math.max(1000, deadline - this.now())));
    }
  }

  /**
   * What the agent using this needs to know, in the one field MCP has for it.
   *
   * Deliberately about OWNERSHIP AND COST rather than about the API. An agent
   * that knows the verbs and not the consequences will start a runner, get its
   * answer, and leave a Mac idling until a timer nobody mentioned kills it.
   */
  #instructions() {
    return [
      'This fleet runs Claude Code sessions on real machines. You are a member of it, with one',
      "person's visibility — you see and can do exactly what they can.",
      '',
      'WORK YOU START IS WORK YOU OWN.',
      `Sessions are expected to finish within about ${this.budgetMinutes} minutes. Nothing in the fleet`,
      'reports "done" — a finished session looks exactly like an idle one — so deciding it is over is',
      'your job, not something you will be told.',
      '',
      '  1. fleet_start, naming a host or a tag if you want a particular kind of machine',
      '  2. fleet_await — it returns when the session needs an answer or ends. Do not poll.',
      '  3. fleet_read_log to collect what it produced. This survives the session; its pane does not.',
      '  4. fleet_stop WHEN YOU HAVE WHAT YOU CAME FOR, or when the time above has passed',
      '',
      'You may only stop sessions you started in this conversation. Anything else belongs to a person',
      'who is probably still using it.',
      '',
      'TEMPORARY HOSTS COST MONEY WHILE THEY LIVE. A host named gha-… is a CI runner: it exists for',
      'one job, belongs to whoever started it, and is destroyed when its job ends — taking any session',
      'on it with it. It is never chosen for you, so reaching one means naming it. Work left running',
      'there is not saved anywhere and is billed until the runner expires.',
      '',
      'TAGS PICK A KIND OF MACHINE. Pass `tag: "macos"` or `tag: "linux"` and the fleet finds a permanent',
      'host carrying it. If the only match is temporary you are told its name rather than sent there — a',
      'runner is offered, never chosen for you.',
      '',
      'Refusals name a reason. Read it — "claude is not logged in on deb132" is a different problem',
      'from "no hosts", and retrying will fix neither.',
    ].join('\n');
  }

  /** @param {string} line */
  async handleLine(line) {
    const text = line.trim();
    if (!text) return;
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      // No id to answer against, so there is nobody to tell. Logging to stderr
      // rather than stdout matters: stdout IS the protocol, and a stray line
      // there desynchronises the client.
      this.log('mcp: ignored a line that was not JSON');
      return;
    }
    // A NOTIFICATION HAS NO ID AND GETS NO REPLY. Answering one is a protocol
    // error that some clients tolerate and others hang on.
    const isNotification = message.id === undefined || message.id === null;
    try {
      const result = await this.#dispatch(message);
      if (!isNotification && result !== undefined) {
        this.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
      }
    } catch (e) {
      if (isNotification) return;
      const err = /** @type {any} */ (e);
      this.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: message.id,
          error: { code: typeof err.code === 'number' ? err.code : -32603, message: String(err.message || err) },
        }),
      );
    }
  }

  /** @param {any} message */
  async #dispatch(message) {
    switch (message.method) {
      case 'initialize':
        return {
          protocolVersion: PROTOCOL,
          capabilities: { tools: {} },
          serverInfo: { name: 'fleetwright', version: '1' },
          // THE CONTRACT, HANDED TO THE MODEL. This is the answer to "nothing
          // reports completion": the fleet does not need a new signal if the
          // thing driving it is told what it owns and what it costs. A deadline
          // in prose that the agent can act on beats a callback that has to be
          // built, and it is honest about who is deciding.
          instructions: this.#instructions(),
        };
      // Notifications. Answered with undefined so nothing is written.
      case 'notifications/initialized':
      case 'notifications/cancelled':
        return undefined;
      case 'tools/list':
        return {
          tools: this.tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
        };
      case 'tools/call':
        return await this.#call(message.params || {});
      case 'ping':
        return {};
      default: {
        const e = new Error(`unknown method ${message.method}`);
        /** @type {any} */ (e).code = -32601;
        throw e;
      }
    }
  }

  /** @param {{ name?: string, arguments?: Record<string, any> }} params */
  async #call({ name, arguments: args = {} }) {
    const tool = this.tools.find((t) => t.name === name);
    if (!tool) {
      // NAMES WHAT IS AVAILABLE. A verb left out on purpose and a verb that
      // does not exist are different situations, and an agent told only "no"
      // will try again differently rather than stop.
      const withheld = DEFAULT_DENY.includes(String(name || '').replace(/^fleet_/, ''));
      return this.#text(
        withheld
          ? `${name} is not exposed by this server. It restarts machines, destroys conversations or moves credentials — ` +
              'ask the person running it to allow that verb explicitly.'
          : `No such tool: ${name}. Available: ${this.tools.map((t) => t.name).join(', ')}.`,
        true,
      );
    }

    const { host, tag, ...params } = args;

    // A LOCAL TOOL — the waiting happens here, not in the fleet.
    if (tool.local) return await this.#await(params, host ? String(host) : null);

    // ONLY WHAT THIS CONVERSATION STARTED. The instructions ask the agent to
    // clean up after itself, which means `stop` has to be available — and an
    // agent that could stop anything would eventually stop somebody's work
    // because a name looked familiar. The check lives here rather than in the
    // coordinator because it is about this SESSION of the server, which is the
    // only place that knows what "you started it" means.
    if (tool.verb === 'stop' && !this.started.has(String(params.name || ''))) {
      return this.#text(
        `${params.name || 'that session'} was not started in this conversation, so it is not yours to stop. ` +
          'It belongs to somebody who is probably still using it.',
        true,
      );
    }

    /** @type {any} */
    let reply;
    try {
      reply = await this.#intent(tool.verb, params, host ? String(host) : null, tag ? String(tag) : null);
    } catch (e) {
      // A TOOL ERROR, NOT A PROTOCOL ERROR. The call was well-formed; the fleet
      // could not be reached. isError lets the agent see it and carry on rather
      // than the client treating the session as broken.
      return this.#text(`Could not reach the fleet: ${/** @type {Error} */ (e).message}`, true);
    }

    // Remembered only on success, and forgotten when it is stopped — so the
    // set is what is actually running because of this conversation.
    if (reply?.ok !== false) {
      const named = String(params.name || reply?.name || '');
      if (tool.verb === 'start' || tool.verb === 'resume') {
        if (named) this.started.add(named);
      } else if (tool.verb === 'stop') {
        this.started.delete(named);
      }
    }

    // Remembered only on success, and forgotten when stopped — so the set is
    // what is actually running because of this conversation.
    if (reply?.ok !== false) {
      const named = String(params.name || reply?.name || '');
      if (named && (tool.verb === 'start' || tool.verb === 'resume')) this.started.add(named);
      if (tool.verb === 'stop') this.started.delete(named);
    }

    // Refusals arrive as data, and they name a reason — that is the property
    // the protocol was built for and the one an agent most needs, so it is
    // passed through rather than flattened into "failed".
    const failed = reply?.ok === false;
    const body = reply?.text ?? JSON.stringify(reply, null, 1);
    return this.#text(String(body), failed);
  }

  /**
   * @param {string} verb
   * @param {Record<string, any>} params
   * @param {string|null} host
   * @param {string|null} [tag]
   */
  async #intent(verb, params, host, tag = null) {
    const res = await this.fetch(`${this.coordinator}/api/intent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.credential}` },
      // Placement travels BESIDE the intent, never inside its params — a host
      // validates the intent, and a tag is not part of what it was asked to do.
      body: JSON.stringify({ verb, params, ...(host ? { host } : {}), ...(tag ? { tag } : {}) }),
    });
    if (res.status === 401 || res.status === 403) {
      throw new Error('this credential was refused — it may have been revoked from the app');
    }
    return await res.json();
  }

  /** @param {string} text @param {boolean} [isError] */
  #text(text, isError = false) {
    return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) };
  }
}
