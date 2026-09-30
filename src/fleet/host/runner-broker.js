// The credential broker, on a runner.
//
// THE SEAM docs/runner-central.md named. The broker is a route on the hook
// socket, and a hook socket is served only for SANDBOXED sessions: one socket
// per container, bind-mounted into exactly that container, so which socket a
// request arrives on is what says which session asked. A runner runs
// unsandboxed on purpose (the machine is destroyed within the hour by something
// more thorough than a container), so there is no container to mount into and
// no per-session socket to tell sessions apart by.
//
// ON A RUNNER THAT PROPERTY IS NOT NEEDED, and the reason is ownership, not
// convenience. An ephemeral host takes work from its owner and nobody else
// (placement, scheduler.js), so every session on it is one person's; and an
// unsandboxed process could open any session's socket anyway. So a runner gets
// ONE socket, in its private state directory, 0600, served by the sidecar —
// the process that holds the coordinator connection a mint has to travel over.
//
// Same route, same body shape and same answers as the hook socket's broker, so
// sandbox/credential.mjs is the client in both places. What it adds is `repo`:
// a runner is only ever given a token for one repository, so it has to be told
// which. git says so when credential.useHttpPath is on, which the runner
// workflow sets.

import http from 'node:http';
import { chmodSync, rmSync } from 'node:fs';

/** Same path as the hook socket's broker route, so one client serves both. */
export const RUNNER_CREDENTIAL_PATH = '/internal/credential';

/**
 * How a runner asks GitHub for its job token, with an audience of its choosing.
 *
 * The request variables exist only in a job with `permissions: id-token:
 * write`, and only in the processes that job started — which is why the
 * sidecar, started in the job's own step, is the process that asks.
 *
 * @param {Record<string, string|undefined>} env
 * @param {typeof globalThis.fetch} [fetchImpl]
 * @returns {((audience: string) => Promise<string>)|null}
 */
export function actionsJobToken(env, fetchImpl = fetch) {
  const url = env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const token = env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!url || !token) return null;
  return async (audience) => {
    const res = await fetchImpl(`${url}&audience=${encodeURIComponent(audience)}`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`GitHub refused to mint a job token (${res.status})`);
    const value = (/** @type {any} */ (await res.json()))?.value;
    if (typeof value !== 'string' || !value) throw new Error('GitHub answered without a job token');
    return value;
  };
}

/**
 * Serve the runner's broker on a unix socket.
 *
 * @param {{ path: string, answer: (ask: { provider?: unknown, repo?: unknown }) => Promise<object>,
 *   log?: { info: Function, warn: Function } }} opts
 * @returns {Promise<http.Server>}
 */
export async function serveRunnerBroker({ path, answer, log = { info() {}, warn() {} } }) {
  // A socket left by a sidecar that died holds the path, and listen() on it
  // fails with EADDRINUSE. Nothing else lives at this path.
  rmSync(path, { force: true });
  const server = http.createServer((req, res) => {
    /** @param {number} status @param {object} body */
    const send = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.method !== 'POST' || req.url !== RUNNER_CREDENTIAL_PATH) {
      send(404, { ok: false, error: 'not_found', message: 'This socket answers credential requests and nothing else.' });
      return;
    }
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c) => {
      body += c;
      // A credential request is a provider and a repository. Anything the size
      // of a file is not one.
      if (body.length > 4096) req.destroy();
    });
    req.on('end', async () => {
      /** @type {any} */
      let ask = {};
      try {
        ask = JSON.parse(body || '{}');
      } catch {
        send(400, { ok: false, error: 'bad_request', message: 'The request was not JSON.' });
        return;
      }
      try {
        send(200, await answer({ provider: ask?.provider, repo: ask?.repo }));
      } catch (e) {
        send(500, { ok: false, error: 'internal', message: String(/** @type {Error} */ (e).message) });
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, () => resolve(undefined));
  });
  // Owner only. The state directory is 0700 already; this is the second lock
  // on the same door, because the socket hands out a person's access.
  chmodSync(path, 0o600);
  log.info(`sidecar: runner credential broker on ${path}`);
  return server;
}
