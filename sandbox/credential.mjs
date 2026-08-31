// The container side of the credential broker.
//
// Two jobs in one file, because they answer the same question in two protocols:
//
//   fleet-cred <provider>        prints KEY=value lines for `eval`
//   git-credential-fleet get     speaks git's credential helper protocol
//
// It sends NO identity. The socket bind-mounted at /run/hub.sock belongs to
// exactly one session on the host, and that is what says which session this is
// — the same property the SessionStart hook relies on. A name in the body would
// only ever be a claim somebody has to decide whether to believe.
//
// NOTHING IS CACHED, ON PURPOSE. Caching would recreate the thing this
// replaces: a copy of the token, frozen at the moment it was taken. Asking each
// time is what makes a rotation land in a running session.

import { request } from 'node:http';

const SOCKET = process.env.AGENT_SESSION_HOOK_SOCKET || '/run/hub.sock';
const PATHNAME = '/internal/credential';

/**
 * @param {string} provider
 * @returns {Promise<{ ok: boolean, env?: Record<string,string>, message?: string }>}
 */
function ask(provider) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ provider });
    const req = request(
      {
        socketPath: SOCKET,
        path: PATHNAME,
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
        timeout: 10_000,
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (text += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(text));
          } catch {
            resolve({ ok: false, message: `the host answered something that is not JSON (${res.statusCode})` });
          }
        });
      },
    );
    // A broker that is not there must not hang a build. Every failure below is
    // the same shape as "not connected", because from in here they are: there
    // is no token, and the reason is worth printing but not worth crashing on.
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, message: 'the credential broker did not answer in time' });
    });
    req.on('error', (e) => resolve({ ok: false, message: `no credential broker on this session (${e.message})` }));
    req.end(body);
  });
}

/** git speaks `key=value` lines on stdin, terminated by a blank line or EOF. */
async function readGitRequest() {
  /** @type {Record<string, string>} */
  const ask = {};
  let text = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) text += chunk;
  for (const line of text.split('\n')) {
    const eq = line.indexOf('=');
    if (eq > 0) ask[line.slice(0, eq)] = line.slice(eq + 1).trim();
  }
  return ask;
}

const mode = process.argv[2] || '';

if (mode === 'get' || mode === 'store' || mode === 'erase') {
  // The git credential helper protocol. `store` and `erase` are accepted and
  // do nothing: git calls them after a success or a failure, and a helper that
  // errors on them turns a working push into a confusing one. There is nothing
  // to store — the host already has it — and nothing to erase.
  if (mode !== 'get') process.exit(0);
  const q = await readGitRequest();
  // https only, and only hosts we actually have a token for. A helper that
  // answers for any host hands a GitHub token to whatever a session was told to
  // clone from.
  const host = (q.host || '').toLowerCase();
  const provider = host === 'github.com' || host === 'gist.github.com' ? 'github' : null;
  if ((q.protocol || '').toLowerCase() !== 'https' || !provider) process.exit(0);
  const got = await ask(provider);
  const token = got.ok && got.env ? got.env.GH_TOKEN || got.env.GITHUB_TOKEN : null;
  // SILENCE IS THE REFUSAL. git falls through to the next helper and then to
  // asking a person; a non-zero exit here breaks clones of public repositories
  // that never needed a credential.
  if (!token) process.exit(0);
  process.stdout.write(`username=x-access-token\npassword=${token}\n`);
  process.exit(0);
}

// fleet-cred <provider> — for `eval "$(fleet-cred github)"`, and for the shims.
const provider = mode || 'github';
const got = await ask(provider);
if (!got.ok || !got.env) {
  process.stderr.write(`${got.message || 'no credential'}\n`);
  process.exit(1);
}
for (const [key, value] of Object.entries(got.env)) {
  // Single-quoted with the standard '\'' escape: this is eval'd by a shell, and
  // a token is arbitrary bytes as far as this file is concerned.
  process.stdout.write(`export ${key}='${value.replace(/'/g, "'\\''")}'\n`);
}
