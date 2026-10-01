// The person's own GitHub token, on their own computer, for fleetwright-mcp.
//
// With one, `fleet_provision` starts the machine from here as them and needs no
// permanent box (McpServer#provisionHere). Only the stdio server asks: it runs
// as the person, where `gh` is signed in. The hosted server has no token of
// theirs and never imports this, which is also why it is not in server.js:
// that file is bundled into the Worker, and the Worker has no child_process.

import { execFileSync } from 'node:child_process';

/**
 * `GH_TOKEN`, then `GITHUB_TOKEN` (the two `gh` itself reads), then whatever
 * `gh auth token` prints. Null when there is none, which is an answer: a box
 * dispatches instead.
 *
 * Asked each time rather than once: `gh` renews its own token, and a person
 * who signs in after starting the server should not have to restart it.
 *
 * @param {{ env?: Record<string, string|undefined>, exec?: (cmd: string, args: string[], opts: any) => string|Buffer }} [o]
 * @returns {string|null}
 */
export function localGithubToken({ env = process.env, exec = /** @type {any} */ (execFileSync) } = {}) {
  const set = (env.GH_TOKEN || env.GITHUB_TOKEN || '').trim();
  if (set) return set;
  try {
    return String(exec('gh', ['auth', 'token'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] })).trim() || null;
  } catch {
    // No `gh`, or not signed in: both mean "not from here".
    return null;
  }
}
