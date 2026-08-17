// The SessionStart hook, inside the sandbox.
//
// Claude pipes this its own session_id and transcript path, so the conversation
// uuid reported is authoritative rather than scraped — that is what makes
// resume reliable rather than best-effort.
//
// The difference from the host version: it posts to a UNIX SOCKET, and sends no
// session name. The socket bind-mounted at /run/hub.sock belongs to exactly one
// session, so the host already knows which one this is. A container cannot
// name a session it cannot reach, which is what removes the forgeable `name`
// field the shared HTTP endpoint has to accept. See docs/hook-socket.md.
//
// Always exits 0. A hook that fails must never block a session from starting.

import { request } from 'node:http';

const SOCKET = process.env.AGENT_SESSION_HOOK_SOCKET || '/run/hub.sock';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f-]{27}$/;

const raw = await readStdin();
let payload = {};
try {
  payload = JSON.parse(raw || '{}');
} catch { /* nothing to report */ }

// The transcript filename IS the conversation uuid, which makes it the most
// reliable source; session_id is the fallback.
const fromPath = String(payload.transcript_path || '').match(/([0-9a-f]{8}-[0-9a-f-]{27})\.jsonl$/);
const uuid = fromPath ? fromPath[1] : String(payload.session_id || '');
if (!UUID_RE.test(uuid)) process.exit(0);

await post({ uuid, cwd: String(payload.cwd || process.cwd()) }).catch(() => {});
process.exit(0);

/** @param {{uuid: string, cwd: string}} body */
function post(body) {
  return new Promise((resolve) => {
    const data = JSON.stringify(body);
    const req = request(
      {
        socketPath: SOCKET,
        method: 'POST',
        path: '/internal/session-start',
        headers: { 'content-type': 'application/json', host: 'hub', 'content-length': Buffer.byteLength(data) },
        timeout: 3000,
      },
      (res) => {
        res.resume();
        res.on('end', resolve);
      },
    );
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
    req.on('error', () => resolve(null));
    req.end(data);
  });
}

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    // If nothing is piped in, do not hang the session waiting for EOF.
    const timer = setTimeout(() => resolve(data), 2000);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => {
      clearTimeout(timer);
      resolve(data);
    });
    process.stdin.on('error', () => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}
