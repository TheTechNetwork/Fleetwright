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
 * @property {typeof fetch} [fetch]
 * @property {(line: string) => void} [write]
 * @property {(m: string) => void} [log]
 */

export class McpServer {
  /** @param {Options} opts */
  constructor({ coordinator, credential, allow = null, fetch: doFetch = fetch, write, log = () => {} }) {
    this.coordinator = String(coordinator || '').replace(/\/+$/, '');
    this.credential = credential;
    this.tools = toolsFor({ allow });
    this.fetch = doFetch;
    // Every reply goes through here so the transport is injectable and the
    // whole server is testable without a pipe.
    this.write = write || ((line) => process.stdout.write(`${line}\n`));
    this.log = log;
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

    const { host, ...params } = args;
    /** @type {any} */
    let reply;
    try {
      reply = await this.#intent(tool.verb, params, host ? String(host) : null);
    } catch (e) {
      // A TOOL ERROR, NOT A PROTOCOL ERROR. The call was well-formed; the fleet
      // could not be reached. isError lets the agent see it and carry on rather
      // than the client treating the session as broken.
      return this.#text(`Could not reach the fleet: ${/** @type {Error} */ (e).message}`, true);
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
   */
  async #intent(verb, params, host) {
    const res = await this.fetch(`${this.coordinator}/api/intent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.credential}` },
      body: JSON.stringify({ verb, params, ...(host ? { host } : {}) }),
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
