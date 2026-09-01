// A client for a STOCK agent-hub's loopback HTTP API.
//
// The sidecar drives agent-hub the same way its own CLI does — over
// 127.0.0.1:8790 — rather than by being loaded into it. Nothing in agent-hub
// changes, and nothing here depends on agent-hub's internals beyond the four
// routes it publishes:
//
//   POST /api/command              {command}  → {ok, text, sessions?, buttons?}
//   GET  /api/state                           → {host, maxSessions, running, auth, sessions}
//   GET  /api/peek?name=…                     → {name, text} | 404
//   POST /internal/session-start   {name,cwd,uuid} → {ok, message}
//   GET  /healthz                             → {ok, host}
//
// Three things about that API are worth knowing before reading the sidecar,
// because each one shows up as a deliberate compromise there:
//
//  1. **/api/peek is fixed at 60 lines.** There is no `lines` parameter on the
//     wire (`sessions.peek(name, 60)` is hardcoded), so a `lines` request can
//     only ever narrow what comes back, never widen it.
//
//  2. **/api/command hardcodes `actor: 'web'`.** Every HTTP token holder is
//     anonymous and indistinguishable to agent-hub, so the sidecar CANNOT make
//     `createdBy` reflect who actually asked. It records the real actor in its
//     own logs and replies; agent-hub's own record will say "web". This is the
//     flat-allowlist gap design.md §1 lists, and it is not fixable from out
//     here — only upstream, or in the coordinator.
//
//  3. **/internal/session-start is loopback-only and never token-gated**, by
//     design: the hook runs as a child of a claude process on the same box, and
//     giving it the operator token would mean writing that token into a
//     world-readable hook script. The sidecar runs on that same box, so it can
//     forward hook reports there — which is what lets the per-session hook
//     socket work without modifying agent-hub at all.
//
// The credential: whatever AGENT_HUB_TOKEN the hub was configured with. A hub
// bound to loopback may have none, in which case there is nothing to send.
// Holding that token is the sidecar's real privilege — /api/command will run
// ANY command line, including /login. The verb allowlist in the sidecar is the
// only thing standing between the coordinator and that, which is why the
// command line is built from literals there and never received.

/** Distinguishable failures, so a coordinator can tell "hub is down" — which it
 * should retry — from "the hub refused" — which it should not. */
export class HubError extends Error {
  /** @param {string} code @param {string} message @param {number|null} [status] */
  constructor(code, message, status = null) {
    super(message);
    this.name = 'HubError';
    this.code = code;
    this.status = status;
  }
}

/**
 * @typedef {object} HubReply
 * @property {boolean} [ok]
 * @property {string} [text]
 * @property {any[]} [sessions]
 * @property {any[]} [buttons]
 * @property {{ catalogue: any[], connected: any[] }} [connections]
 * @property {{ ok: boolean, account?: string, granted?: string[]|null, wants?: string[]|null, missing?: string[]|null, message: string }} [check]
 * @property {Array<{ name: string, kind: string, size: number }>} [entries] a
 *   directory listing, carried as data so an app never parses the rendered text
 */

export class HubClient {
  /**
   * @param {{
   *   baseUrl?: string,
   *   token?: string|null,
   *   commandTimeoutMs?: number,
   *   readTimeoutMs?: number,
   *   fetchImpl?: typeof fetch,
   * }} opts
   */
  constructor({
    baseUrl = 'http://127.0.0.1:8790',
    token = null,
    // Generous on purpose, and matching agent-hub's own CLI. Several commands
    // legitimately take a while: a start waits out the Remote Control check
    // (up to ~2×10s), a resume waits for the dialog to render, and a login
    // waits up to 45s for an authorization URL. A short timeout here reports a
    // perfectly healthy hub as unreachable.
    commandTimeoutMs = 300_000,
    readTimeoutMs = 10_000,
    fetchImpl,
  } = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.token = token || null;
    this.commandTimeoutMs = commandTimeoutMs;
    this.readTimeoutMs = readTimeoutMs;
    this.fetch = fetchImpl || globalThis.fetch;
  }

  /**
   * Run one command line through agent-hub's command registry — the same
   * registry Telegram, the web UI and the CLI all go through, so a fleet
   * command can never behave differently from the same command typed in chat.
   *
   * @param {string} line
   * @returns {Promise<HubReply>}
   */
  async command(line, meta = {}) {
    // `meta` carries prose — a title, a brief — as FIELDS beside the command.
    // Never appended to `line`: everything in there is split on whitespace, so
    // a title with spaces would arrive as arguments and a title that looks like
    // a flag would arrive as a flag. The hub validates them again on arrival,
    // because this is not the only caller that can reach that route.
    return this.#json('POST', '/api/command', { command: line, ...meta }, this.commandTimeoutMs);
  }

  /** Everything the hub knows: sessions, cap, auth. @returns {Promise<any>} */
  async state() {
    return this.#json('GET', '/api/state', null, this.readTimeoutMs);
  }

  /**
   * The last lines of a session's pane, or null when it is not running.
   *
   * agent-hub serves a fixed 60 lines, so `lines` can only trim. Trimming
   * client-side rather than pretending the parameter reached the hub keeps the
   * limitation visible instead of silently ignored.
   *
   * @param {string} name
   * @param {number|null} [lines]
   * @returns {Promise<string|null>}
   */
  async peek(name, lines = null) {
    const r = await this.#json('GET', `/api/peek?name=${encodeURIComponent(name)}`, null, this.readTimeoutMs, {
      // "not running" is an ordinary answer, not a transport failure.
      allowStatus: [404],
    });
    if (r.__status === 404) return null;
    const text = typeof r.text === 'string' ? r.text : '';
    if (!lines || lines <= 0) return text;
    const rows = text.split('\n');
    return rows.length <= lines ? text : rows.slice(-lines).join('\n');
  }

  /**
   * Hand a conversation uuid to the hub, as the SessionStart hook would.
   *
   * This is how the per-session hook socket reaches a stock agent-hub: the
   * sidecar owns the socket, so it knows which session a report came from, and
   * forwards it here with that name attached. The container never gets to name
   * a session, and agent-hub is unchanged.
   *
   * @param {{ name: string, cwd?: string|null, uuid: string }} rec
   * @returns {Promise<{ ok: boolean, message?: string }>}
   */
  async recordSessionStart({ name, cwd = null, uuid }) {
    const r = await this.#json(
      'POST',
      '/internal/session-start',
      { name, ...(cwd ? { cwd } : {}), uuid },
      this.readTimeoutMs,
      { allowStatus: [400, 403] },
    );
    return { ok: r.ok === true, message: r.message || r.error };
  }

  /** Liveness only. @returns {Promise<boolean>} */
  async alive() {
    try {
      const r = await this.#json('GET', '/healthz', null, this.readTimeoutMs);
      return r.ok === true;
    } catch {
      return false;
    }
  }

  /**
   * @param {string} method
   * @param {string} path
   * @param {unknown} body
   * @param {number} timeoutMs
   * @param {{ allowStatus?: number[] }} [opts]
   * @returns {Promise<any>}
   */
  async #json(method, path, body, timeoutMs, { allowStatus = [] } = {}) {
    /** @type {Record<string, string>} */
    const headers = { accept: 'application/json' };
    if (body !== null && body !== undefined) headers['content-type'] = 'application/json';
    if (this.token) headers.authorization = `Bearer ${this.token}`;

    let res;
    try {
      res = await this.fetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        ...(body === null || body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      const err = /** @type {Error} */ (e);
      // The common one by far: the hub is restarting, or was never up. The
      // coordinator needs this to be distinguishable so it retries rather than
      // reporting a refusal to whoever asked.
      throw new HubError(
        err.name === 'TimeoutError' ? 'hub_timeout' : 'hub_unreachable',
        `${method} ${path}: ${err.message}`,
      );
    }

    if (res.status === 401) {
      throw new HubError('hub_unauthorised', `${method} ${path}: rejected the token — check AGENT_HUB_TOKEN`, 401);
    }
    if (!res.ok && !allowStatus.includes(res.status)) {
      throw new HubError('hub_error', `${method} ${path}: HTTP ${res.status}`, res.status);
    }

    const text = await res.text();
    let parsed;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      // A hub that answers HTML where JSON was expected is almost always
      // something else on that port — a tunnel login page, a different service.
      throw new HubError('hub_error', `${method} ${path}: reply was not JSON`, res.status);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new HubError('hub_error', `${method} ${path}: reply was not a JSON object`, res.status);
    }
    return { ...parsed, __status: res.status };
  }
}
