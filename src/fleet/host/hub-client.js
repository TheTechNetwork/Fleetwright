// A client for a STOCK fleetwright's loopback HTTP API.
//
// The sidecar drives fleetwright the same way its own CLI does — over
// 127.0.0.1:8790 — rather than by being loaded into it. Nothing in fleetwright
// changes, and nothing here depends on fleetwright's internals beyond the four
// routes it publishes:
//
//   POST /api/command              {command}  → {ok, text, sessions?, buttons?}
//   GET  /api/state                           → {host, maxSessions, running, auth, sessions, labels, channel, sandbox, …}
//   GET  /api/peek?name=…                     → {name, text} | 404
//   POST /api/update-evidence      {which}    → {ok, noted, why?}
//   POST /api/renew-providers      {secrets}  → {ok, results}
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
//     anonymous and indistinguishable to fleetwright, so the sidecar CANNOT make
//     `createdBy` reflect who actually asked. It records the real actor in its
//     own logs and replies; fleetwright's own record will say "web". This is the
//     flat-allowlist gap design.md §1 lists, and it is not fixable from out
//     here — only upstream, or in the coordinator.
//
//  3. **Everything the sidecar knows about the box, it is told.** The labels,
//     channel, variant and house rules on the health frame are read off
//     /api/state, and the two things it used to write into fleetwright's state
//     directory — the commit-confirm evidence, a renewed provider token — are
//     requests. This client never opens a file of fleetwright's, which is what
//     lets the two run as different users (#270).
//
// The credential: the sidecar's own token, which the hub mints beside the
// operator's and the installer copies into this process's env — or, on a hub
// from before that existed, the operator's token itself. The hub gates the
// first to the routes this client calls and the command shapes toCommandLine
// builds (src/core/sidecar-scope.js), and the second to nothing. Holding
// either is still the sidecar's real privilege — the fleet's verbs ARE start,
// stop and link. The verb allowlist in the sidecar is what stands between the
// coordinator and that, which is why the command line is built from literals
// there and never received.

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
 * @property {Array<{ name: string, summary: string, chars: number }>} [profiles]
 *   the task profiles that host has, as data
 * @property {Array<{ name: string }>} [secrets]
 *   the named secrets that host holds, by name only — never a value
 * @property {string} [channel] which releases that box installs
 * @property {boolean} [channelPinned] its environment is forcing the channel,
 *   so an app must show the answer and not offer to change it
 * @property {{ variant: string, image: string, pinned: boolean }} [sandbox]
 *   which image new sessions on that box run in, and whether its environment
 *   names the image outright — so an app shows the answer rather than offering
 *   a change that will be refused
 * @property {Array<{ name: string, kind: string, size: number }>} [entries] a
 *   directory listing, carried as data so an app never parses the rendered text
 * @property {{
 *   app: { kind?: string, pending?: boolean, available?: string|null, configured?: boolean, behind?: number|null, text?: string },
 *   system: { supported?: boolean, pending?: boolean, count?: number, text?: string },
 * }} [waiting] what a check found, as data — kind, pending, version — so a row
 *   renders a state instead of parsing a sentence
 * @property {{ sessions: number, pinRequired: boolean, hostname: string }} [reboot]
 *   what a reboot would cost, so a screen asks for as much as the loss is worth
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
    // Generous on purpose, and matching fleetwright's own CLI. Several commands
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
   * Run one command line through fleetwright's command registry — the same
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
   * fleetwright serves a fixed 60 lines, so `lines` can only trim. Trimming
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
   * Record that this box reached its coordinator — the sidecar's half of the
   * evidence that a release on trial did not sever it from the fleet. See
   * src/core/update-confirm.js; the file is fleetwright's and it writes it.
   *
   * A hub from before the route answers 404, reported as not noted with the
   * reason rather than thrown: a connect is not the place to fail, and the
   * standing watchdog reverting an update for lack of evidence is a louder
   * signal than this log line would be.
   *
   * @returns {Promise<{ noted: boolean, why?: string }>}
   */
  async noteCoordinatorReached() {
    const r = await this.#json('POST', '/api/update-evidence', { which: 'coord' }, this.readTimeoutMs, {
      allowStatus: [404],
    });
    if (r.__status === 404) return { noted: false, why: 'fleetwright here has no update-evidence route — update it' };
    return { noted: r.noted === true, ...(r.why ? { why: String(r.why) } : {}) };
  }

  /**
   * Have fleetwright trade the refresh tokens in its store for new access
   * tokens, using the client secrets this process holds in memory.
   *
   * The secrets travel to fleetwright over the loopback for one request and
   * are not kept there; see src/core/keepalive.js for why the exchange needs
   * them and src/fleet/protocol/config-frame.js for why nothing writes them
   * down. Null for a hub from before the route, so the caller can say so.
   *
   * @param {Record<string, string>} secrets
   * @returns {Promise<Array<{ row: string, provider: string, outcome: string, detail?: string }>|null>}
   */
  async renewProviders(secrets) {
    const r = await this.#json('POST', '/api/renew-providers', { secrets }, this.commandTimeoutMs, {
      allowStatus: [404],
    });
    if (r.__status === 404) return null;
    return Array.isArray(r.results) ? r.results : [];
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
      throw new HubError('hub_unauthorised', `${method} ${path}: rejected the token — check FLEETWRIGHT_TOKEN`, 401);
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
