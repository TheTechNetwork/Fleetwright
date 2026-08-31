// The per-session hook transport: a unix socket per sandboxed session, bind-
// mounted into that session's container and nowhere else.
//
// WHAT THIS REPLACES
//
// agent-hub's SessionStart hook posts a conversation uuid to the hub's loopback
// HTTP port, at /internal/session-start. That endpoint is deliberately not
// token-gated — the hook runs as a child of a claude process on the same box,
// and making it carry the operator token would mean writing that token into a
// world-readable hook script. The cost is that ANY local process can post ANY
// name+uuid, so any local process can repoint a session's resume target at a
// conversation of its choosing.
//
// Inside the container that stops being acceptable: the whole point of §2 is
// that a session gets real root, and a root-capable session that can reach a
// shared unauthenticated endpoint can rewrite every other session's resume
// target. A nonce would be the obvious patch, and the wrong one — it has to be
// generated, delivered into the container, and rotated, and the container can
// read it.
//
// Instead the isolation supplies the authentication. Each session gets its own
// socket on the host:
//
//     /run/agent-fleet/<name>.sock
//
// and podman mounts exactly that one into exactly that one container, always at
// the same path inside:
//
//     -v /run/agent-fleet/<name>.sock:/run/hub.sock
//
// So the session name is a property of WHICH SOCKET the request arrived on, not
// of anything in the request. The container cannot name another session because
// it has no way to reach another session's socket, and it does not need to know
// its own name to report — which is why the client below sends no name at all.
//
// That inverts the trust relationship: the body used to be the authority and
// was forgeable; now the socket is the authority and is not.
//
// WHERE THIS LIVES, AND WHY IT MOVED
//
// This is core, not fleet. The sandbox is a session-manager feature, and a
// sandboxed session's conversation uuid can only reach the registry through
// one of these — so the session manager has to own it. When the fleet sidecar
// owned it, a box running without a sidecar started sandboxed sessions whose
// hook could not report, which made them silently unresumable: the single
// failure this whole tool exists to prevent, arriving quietly.
//
// The sidecar still uses it, for the same reason it always did. It just is not
// the only thing that can.

import { answerCredentialRequest, CREDENTIAL_PATH } from './credential-broker.js';
import { createServer as createHttpServer } from 'node:http';
import { request as httpRequest } from 'node:http';
import { createConnection } from 'node:net';
import { chmodSync, mkdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';

/** The one route a session socket answers. Same path agent-hub's HTTP adapter
 * uses, so the hook payload and the hub's handler are unchanged. */
export const HOOK_PATH = '/internal/session-start';

/** Where the socket appears INSIDE the container. Fixed, because the session
 * does not know (and must not need to know) its own name on the host. */
export const CONTAINER_SOCKET_PATH = '/run/hub.sock';

/** Default host-side directory holding one socket per live session. */
export const DEFAULT_SOCKET_DIR = '/run/agent-fleet';

/** A conversation uuid, in the shape agent-hub already validates. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f-]{27}$/;

/** Session names, matching agent-hub's charset (core/names.js). A name becomes
 * a filename here, so this is also what keeps `../../etc/passwd` out of it. */
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;

// A hook payload is a uuid, a path and nothing else. Anything approaching a
// megabyte is a bug or an attempt to exhaust memory — and unlike the HTTP
// adapter's caller, this one is inside a container we assume is hostile.
const MAX_BODY_BYTES = 64 * 1024;

/** @param {string} name */
export function isValidSessionName(name) {
  return NAME_RE.test(name);
}

/**
 * @typedef {object} HookReport
 * @property {string} name  taken from the socket, never from the request
 * @property {string|null} cwd
 * @property {string} uuid
 * @property {string|null} [title]
 */

/**
 * @typedef {object} HookSocketOptions
 * @property {string} [dir]                  host directory for the sockets
 * @property {(r: HookReport) => { ok: boolean, message?: string } | Promise<{ ok: boolean, message?: string }>} onSessionStart
 * @property {((name: string) => Record<string, string>|null)} [secretsFor]
 *   The credential broker's reader: the connected tokens belonging to whoever
 *   owns this session, READ AT THE MOMENT OF THE REQUEST. That timing is the
 *   feature — see credential-broker.js. Absent means the broker is off and the
 *   route answers 404, which is what an older or non-sandboxed host does.
 * @property {{ info: (m: string) => void, warn: (m: string) => void }} [logger]
 */

export class HookSocketServer {
  /** @param {HookSocketOptions} opts */
  constructor({ dir = DEFAULT_SOCKET_DIR, onSessionStart, secretsFor, logger }) {
    this.dir = dir;
    this.onSessionStart = onSessionStart;
    this.secretsFor = secretsFor || null;
    this.log = logger || { info: () => {}, warn: () => {} };
    /** @type {Map<string, import('node:http').Server>} */
    this.servers = new Map();
  }

  /** @param {string} name */
  socketPath(name) {
    return path.join(this.dir, `${name}.sock`);
  }

  /**
   * Start listening for one session. Returns the host path to bind-mount.
   *
   * Two layers of access control, because each covers the other's gap:
   *
   *  - The DIRECTORY is 0700. Node creates a unix socket with a mode derived
   *    from the process umask, and there is an unavoidable window between
   *    listen() and chmod() where the socket may be world-writable. A private
   *    directory makes that window unreachable rather than merely short.
   *  - The SOCKET is 0600. Rootless podman maps container-root to the host user
   *    running the hub, so the container reaches it as the owner; nothing else
   *    on the box does.
   *
   * @param {string} name
   * @returns {Promise<string>} the host socket path
   */
  async open(name) {
    if (!isValidSessionName(name)) {
      throw new Error(`not a valid session name: ${JSON.stringify(name)}`);
    }
    if (this.servers.has(name)) return this.socketPath(name);

    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const sock = this.socketPath(name);
    await clearStaleSocket(sock);

    const server = createHttpServer((req, res) => {
      this.#handle(name, req, res).catch((e) => {
        this.log.warn(`hook-socket ${name}: ${/** @type {Error} */ (e).message}`);
        json(res, 500, { ok: false, error: 'internal error' });
      });
    });
    // A container that opens the socket and then says nothing must not pin a
    // handle open forever.
    server.setTimeout(30_000);

    await new Promise((resolve, reject) => {
      server.on('error', reject);
      server.listen(sock, () => resolve(null));
    });
    chmodSync(sock, 0o600);

    this.servers.set(name, server);
    this.log.info(`hook-socket: listening for ${name} at ${sock}`);
    return sock;
  }

  /**
   * Stop listening for one session and remove its socket.
   *
   * Called when the container exits. Leaving the file behind would be harmless
   * on its own — nothing is listening — but it would accumulate, and the next
   * session of the same name would have to clear it.
   * @param {string} name
   */
  async close(name) {
    const server = this.servers.get(name);
    if (server) {
      this.servers.delete(name);
      await new Promise((resolve) => server.close(() => resolve(null)));
    }
    rmSync(this.socketPath(name), { force: true });
  }

  /** Shut every socket down. */
  async closeAll() {
    await Promise.all([...this.servers.keys()].map((n) => this.close(n)));
  }

  /** Session names currently listening. */
  names() {
    return [...this.servers.keys()];
  }

  /**
   * The request handler. `name` is closed over from open() — it is the socket's
   * identity, and is the ONLY source of the session name.
   *
   * @param {string} name
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   */
  async #handle(name, req, res) {
    const route = (req.url || '').split('?')[0];
    if (route === CREDENTIAL_PATH) return this.#credential(name, req, res);
    if (route !== HOOK_PATH) {
      return json(res, 404, { ok: false, error: 'not found' });
    }
    if (req.method !== 'POST') {
      return json(res, 405, { ok: false, error: 'POST only' });
    }

    const body = await readJson(req);
    if (body === null) return json(res, 400, { ok: false, error: 'body too large or not JSON' });

    // The container has no reason to send a name — it does not know which host
    // socket it was handed. One arriving that disagrees with the socket is
    // either a caller built against the old HTTP shape or a session trying to
    // write to a neighbour's record, and both are worth refusing loudly rather
    // than silently overriding.
    if (body.name !== undefined && String(body.name) !== name) {
      this.log.warn(
        `hook-socket ${name}: refused a report naming "${String(body.name).slice(0, 64)}" — ` +
          'the socket is the authority on which session this is',
      );
      return json(res, 403, { ok: false, error: 'session name does not match this socket' });
    }

    const uuid = String(body.uuid || '');
    if (!UUID_RE.test(uuid)) {
      return json(res, 400, { ok: false, error: `not a conversation uuid: ${uuid.slice(0, 64)}` });
    }

    // The cwd is advisory: it is what the session reports about itself, and in
    // a sandbox it is always the container's /work. It never selects a record —
    // the socket already did that — so a wrong value cannot cross sessions.
    const cwd = body.cwd ? String(body.cwd).slice(0, 4096) : null;
    // Advisory in exactly the way cwd is: it labels a record the socket has
    // already identified, so a wrong one cannot reach another session.
    const title = body.title ? String(body.title).slice(0, 200) : null;

    const result = await this.onSessionStart({ name, cwd, uuid, title });
    return json(res, result.ok ? 200 : 400, result);
  }

  /**
   * The credential broker. Same authority as everything else here: the session
   * is WHICHEVER SOCKET THIS ARRIVED ON, and the request carries no identity
   * because none of it could be believed.
   *
   * @param {string} name
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   */
  async #credential(name, req, res) {
    if (!this.secretsFor) {
      return json(res, 404, { ok: false, error: 'not found' });
    }
    if (req.method !== 'POST') {
      return json(res, 405, { ok: false, error: 'POST only' });
    }
    const body = await readJson(req);
    if (body === null) return json(res, 400, { ok: false, error: 'body too large or not JSON' });

    const provider = String(body.provider || '');
    // READ NOW, NOT AT START. The whole point: a token rotated ten minutes ago
    // is the one this returns, and the session that asked did not have to be
    // restarted to see it.
    const answer = answerCredentialRequest({ provider, secrets: this.secretsFor(name) });

    // EVERY GRANT IS LOGGED, AND THE VALUE NEVER IS. What makes the broker
    // better than an environment variable is partly that asking leaves a trace;
    // a trace that quoted the token would undo the rest of it.
    if (answer.ok) {
      this.log.info(`credential-broker: served ${answer.provider} to ${name}`);
    } else {
      this.log.info(`credential-broker: refused ${provider.slice(0, 40) || '(none)'} for ${name} — ${answer.error}`);
    }
    return json(res, answer.ok ? 200 : 404, answer);
  }
}

/**
 * The container side of the transport.
 *
 * This is what agent-hub's `agent-hub hook` runs instead of its HTTP post when
 * it finds itself inside a sandbox. It sends NO session name: the socket it is
 * writing to already determines that, and a name in the body would only ever be
 * a claim the host has to decide whether to believe.
 *
 * Never throws for a transport failure — the caller is a SessionStart hook, and
 * a hook that fails must never block a session from starting. It returns a
 * result the caller can spool on instead.
 *
 * @param {{ socketPath?: string, uuid: string, cwd?: string|null, timeoutMs?: number }} opts
 * @returns {Promise<{ ok: boolean, status: number|null, body: Record<string, unknown>|null, error?: string }>}
 */
export function postSessionStart({ socketPath = CONTAINER_SOCKET_PATH, uuid, cwd = null, timeoutMs = 3000 }) {
  return new Promise((resolve) => {
    const payload = JSON.stringify({ uuid, ...(cwd ? { cwd } : {}) });
    /** @param {string} error */
    const fail = (error) => resolve({ ok: false, status: null, body: null, error });

    const req = httpRequest(
      {
        socketPath,
        method: 'POST',
        path: HOOK_PATH,
        // A unix socket has no host, but HTTP/1.1 requires the header. Node
        // sends "localhost" by default; being explicit keeps the request
        // identical whichever way it is built.
        headers: { 'content-type': 'application/json', host: 'hub', 'content-length': Buffer.byteLength(payload) },
        timeout: timeoutMs,
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c) => {
          text += c;
          if (text.length > MAX_BODY_BYTES) res.destroy();
        });
        res.on('end', () => {
          let body = null;
          try {
            body = JSON.parse(text || '{}');
          } catch {
            /* a non-JSON reply is still a reply; the status is what matters */
          }
          resolve({ ok: (res.statusCode || 0) >= 200 && (res.statusCode || 0) < 300, status: res.statusCode ?? null, body });
        });
      },
    );
    req.on('timeout', () => {
      req.destroy();
      fail(`timed out after ${timeoutMs}ms`);
    });
    req.on('error', (e) => fail(e.message));
    req.end(payload);
  });
}

// --- helpers ---------------------------------------------------------------

/**
 * Remove a socket file left behind by a previous run.
 *
 * Deleting it unconditionally would be a way to hijack a live session: unlink
 * the socket a running container is talking to, listen on the same path, and
 * the next report lands in the wrong process. So probe it first, and only clear
 * a path nothing answers on.
 *
 * @param {string} sock
 */
async function clearStaleSocket(sock) {
  try {
    statSync(sock);
  } catch {
    return; // nothing there
  }
  const live = await new Promise((resolve) => {
    const probe = createConnection(sock);
    const done = (/** @type {boolean} */ answer) => {
      probe.destroy();
      resolve(answer);
    };
    probe.setTimeout(1000, () => done(true)); // answered slowly enough to be real
    probe.on('connect', () => done(true));
    probe.on('error', () => done(false)); // ECONNREFUSED — the listener is gone
  });
  if (live) throw new Error(`${sock} is already in use by a live listener`);
  rmSync(sock, { force: true });
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {unknown} body
 */
function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<Record<string, any>|null>} null when unusable
 */
function readJson(req) {
  return new Promise((resolve) => {
    let body = '';
    let over = false;
    req.on('data', (c) => {
      body += c;
      if (body.length > MAX_BODY_BYTES && !over) {
        over = true;
        req.destroy();
        resolve(null);
      }
    });
    req.on('end', () => {
      if (over) return;
      try {
        const parsed = JSON.parse(body || '{}');
        resolve(parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null);
      } catch {
        resolve(null);
      }
    });
    req.on('error', () => resolve(null));
  });
}
