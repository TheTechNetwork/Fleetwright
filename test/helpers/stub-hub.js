// A stub that speaks fleetwright's HTTP API exactly as src/adapters/http.js does.
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
  facts = {},
  onTrial = false,
  renewResults = [],
  without = [],
} = {}) {
  // Mutable, so a test can take a healthy box and make it degraded — which is
  // the state that used to hide a host's sessions entirely.
  let auth = initialAuth;
  // How many people have linked a Claude account here. Non-zero by default,
  // because a box nobody can start a session on is the unusual case.
  let claudeAccounts = 1;
  /** @type {string[]} */
  const commands = [];
  /** Whole request bodies, so a test can assert what travels BESIDE a command —
   * a title, a file's content, a dispatch ticket. The line alone cannot show
   * that, and "it is not on the command line" is exactly what some of those
   * fields exist to be. @type {any[]} */
  const bodies = [];
  /** The `which` of every evidence request, so a test can see the sidecar
   * asked rather than wrote. @type {string[]} */
  const evidence = [];
  /** The secrets of every renewal request — what the sidecar holds in memory
   * and hands over for one call. @type {Array<Record<string, string>>} */
  const renewals = [];
  // What the hub says about the box: labels, channel, sandbox, house rules.
  // Mutable so a test can change a label and see the next frame say so.
  let hostFacts = facts;

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
        // The facts an older fleetwright did not publish. Spread rather than
        // fixed so a test for that older hub passes none and the fields are
        // simply absent, as they would be.
        ...hostFacts,
        sessions,
      });
    }

    // The two writes the sidecar used to make into fleetwright's state
    // directory itself, now asked for. `without` lets a test stand in for a
    // fleetwright from before either route existed.
    if (without.includes(p)) return json(404, { error: 'not found' });
    if (p === '/api/update-evidence' && req.method === 'POST') {
      if (body.which !== 'coord') return json(400, { ok: false, text: 'only the coordinator half of the evidence is accepted here' });
      evidence.push(String(body.which));
      return json(200, onTrial ? { ok: true, noted: true } : { ok: true, noted: false, why: 'nothing on trial' });
    }
    if (p === '/api/renew-providers' && req.method === 'POST') {
      if (!body.secrets || typeof body.secrets !== 'object') return json(400, { ok: false, text: 'secrets must be an object of strings' });
      renewals.push(body.secrets);
      return json(200, { ok: true, results: renewResults });
    }

    if (p === '/api/command' && req.method === 'POST') {
      const line = String(body.command || '');
      commands.push(line);
      bodies.push(body);
      // fleetwright answers 200 even for a failed command; ok lives in the body.
      //
      // AWAITED, so a test can hold a command open. The watcher's restart is a
      // stop and then a resume with tens of seconds between them on a real box,
      // and the only way to ask what a tick landing in that gap does is to make
      // the gap happen. `await` on a plain object is a no-op, so every existing
      // synchronous onCommand is unaffected.
      return json(200, onCommand ? await onCommand(line) : { ok: true, text: `ran ${line}` });
    }

    if (p === '/api/peek' && req.method === 'GET') {
      const name = url.searchParams.get('name') || '';
      const text = panes[name];
      if (text === undefined) return json(404, { error: 'not running' });
      // Fixed at 60 lines, exactly as fleetwright does. There is no `lines`
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
    /** @param {Record<string, unknown>} next */
    setFacts: (next) => {
      hostFacts = next;
    },
    commands,
    bodies,
    evidence,
    renewals,
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

/** A session record in the shape fleetwright's registry produces. */
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
