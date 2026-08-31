// A stub that speaks agent-hub's HTTP API exactly as src/adapters/http.js does.
//
// Every route, status code and body shape here was taken from that file rather
// than from memory, including the parts that are easy to get wrong and would
// make the sidecar's tests pass against an API that does not exist:
//
//   - /api/peek serves a FIXED 60 lines and has no `lines` parameter
//   - /api/peek answers 404 {error:'not running'} for a session that is not up
//   - /api/command always answers 200, with ok:false inside the body
//   - /internal/session-start is loopback-only and NOT token-gated
//   - a missing/incorrect token is 401 on operator routes only
//
// Anything the sidecar relies on beyond this is a bug in the sidecar.

import { createServer } from 'node:http';

/**
 * @param {{
 *   token?: string|null,
 *   sessions?: any[],
 *   panes?: Record<string, string>,
 *   auth?: Record<string, unknown>,
 *   maxSessions?: number,
 *   host?: string,
 *   onCommand?: (line: string) => any,
 * }} [opts]
 */
export async function startStubHub({
  token = null,
  sessions = [],
  panes = {},
  auth: initialAuth = { loggedIn: true, email: 'box@example.com', summary: 'Logged in as box@example.com' },
  maxSessions = 5,
  host = 'unabandoned',
  onCommand,
} = {}) {
  // Mutable, so a test can take a healthy box and make it degraded — which is
  // the state that used to hide a host's sessions entirely.
  let auth = initialAuth;
  // How many people have linked a Claude account here. Non-zero by default,
  // because a box nobody can start a session on is the unusual case.
  let claudeAccounts = 1;
  /** @type {string[]} */
  const commands = [];
  /** @type {Array<{name: string, cwd: string|null, uuid: string}>} */
  const hookReports = [];

  const server = createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://stub');
    const p = url.pathname;
    /** @param {number} status @param {unknown} body */
    const json = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(body));
    };
    const body = await readBody(req);

    if (p === '/healthz') return json(200, { ok: true, host });

    // Loopback-only and deliberately never token-gated — the hook cannot carry
    // the operator token without that token living in a world-readable script.
    if (p === '/internal/session-start' && req.method === 'POST') {
      if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/.test(String(body.uuid || ''))) {
        return json(400, { ok: false, message: `Not a conversation uuid: ${body.uuid}` });
      }
      hookReports.push({ name: String(body.name || ''), cwd: body.cwd ?? null, uuid: String(body.uuid) });
      return json(200, { ok: true, message: 'recorded' });
    }

    // Everything below is operator surface.
    const bearer = (req.headers.authorization || '').startsWith('Bearer ')
      ? String(req.headers.authorization).slice(7)
      : '';
    if (token && bearer !== token) return json(401, { error: 'unauthorised' });

    if (p === '/api/state' && req.method === 'GET') {
      return json(200, {
        host,
        workdir: '/work',
        maxSessions,
        running: sessions.filter((s) => s.status === 'running').length,
        loginEnabled: true,
        auth,
        claudeAccounts,
        loginPending: null,
        sessions,
      });
    }

    if (p === '/api/command' && req.method === 'POST') {
      const line = String(body.command || '');
      commands.push(line);
      // agent-hub answers 200 even for a failed command; ok lives in the body.
      return json(200, onCommand ? onCommand(line) : { ok: true, text: `ran ${line}` });
    }

    if (p === '/api/peek' && req.method === 'GET') {
      const name = url.searchParams.get('name') || '';
      const text = panes[name];
      if (text === undefined) return json(404, { error: 'not running' });
      // Fixed at 60 lines, exactly as agent-hub does. There is no `lines`
      // parameter on the wire.
      return json(200, { name, text: text.split('\n').slice(-60).join('\n') });
    }

    return json(404, { error: 'not found' });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(null)));
  const address = /** @type {import('node:net').AddressInfo} */ (server.address());

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    /** @param {Record<string, unknown>} next */
    setAuth: (next) => {
      auth = next;
    },
    /** @param {number} n */
    setClaudeAccounts: (n) => {
      claudeAccounts = n;
    },
    commands,
    hookReports,
    sessions,
    panes,
    close: () => new Promise((resolve) => server.close(() => resolve(null))),
  };
}

/** @param {import('node:http').IncomingMessage} req */
function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      try {
        resolve(JSON.parse(raw || '{}'));
      } catch {
        resolve({});
      }
    });
    req.on('error', () => resolve({}));
  });
}

/** A session record in the shape agent-hub's registry produces. */
export function sessionRecord(name, patch = {}) {
  return {
    name,
    cwd: '/work',
    uuid: '11111111-2222-3333-4444-555555555555',
    status: 'stopped',
    resumeOnBoot: false,
    skipPermissions: null,
    detail: null,
    rcUrl: null,
    createdBy: null,
    createdAt: 1,
    updatedAt: 1,
    stoppedAt: null,
    ...patch,
  };
}
