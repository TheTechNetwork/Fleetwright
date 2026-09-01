// The MCP server, reachable over HTTP.
//
// "Let's move to remote with Apple/Google signin." Stdio works only where
// somebody has installed a binary and pasted a credential into a config file;
// a URL works from claude.ai, from a phone, from a machine nobody has set up.
//
// TWO THINGS, AND THEY ARE SEPARABLE. The transport is this file. The
// authorization is oauth.js, and it is where Apple and Google come in — the
// coordinator already turns one of their ID tokens into a device credential
// (`/api/session`), so what OAuth adds is the standard way for a CLIENT to ask
// for that without a human copying a string.
//
// THE CONVERSATION IS UNCHANGED. McpServer.handleMessage takes one JSON-RPC
// message and returns one reply; stdio wraps it in newlines and this wraps it in
// a request. A second implementation of the conversation would be a second thing
// to get wrong.
//
// WHAT A REMOTE TRANSPORT COSTS, said plainly because it is not free:
//
//   fleet_await BLOCKS, and a Worker has a request timeout. Over stdio a
//   five-minute wait is a five-minute wait; here it is a request that may be
//   cut off by infrastructure with no say in the matter. The tool caps its own
//   wait below that ceiling — see MAX_REMOTE_WAIT_MS — so the answer is always
//   "still running", never a severed connection.
//
//   notifications/message has no obvious home. Streamable HTTP puts
//   server-to-server messages on an SSE stream; without one there is nowhere to
//   put them, and this transport does not open one. That costs less than it
//   sounds: measured against Claude Code 2.1.251, notifications are not
//   surfaced to the model at all (docs/mcp.md). The courtesy that does nothing
//   over stdio does nothing here either, and fleet_await remains the path that
//   works.

import { McpServer } from './server.js';

/**
 * How long a blocking tool may wait before answering on a remote transport.
 *
 * Under a platform request limit rather than near it. A Worker gives a request
 * around thirty seconds of CPU and rather longer of wall clock, and the failure
 * mode of guessing high is the worst one available: the client sees a dropped
 * connection instead of an answer, and cannot tell a slow session from a broken
 * server.
 */
export const MAX_REMOTE_WAIT_MS = 25_000;

/**
 * Handle one MCP request.
 *
 * The caller has already authenticated: `credential` is the device token the
 * request arrived with, and the server it builds has exactly that person's
 * visibility — the same rule as stdio, where the credential comes from the
 * environment instead.
 *
 * @param {object} opts
 * @param {any} opts.body            the parsed JSON-RPC message
 * @param {string} opts.credential   the caller's device token
 * @param {string} opts.coordinator  origin to send intents to
 * @param {typeof fetch} [opts.fetch]
 * @param {() => number} [opts.now]                 the clock, for tests
 * @param {(ms: number) => Promise<void>} [opts.sleep]  the wait, for tests
 *
 * `now` and `sleep` are the same seam `fetch` is, and exist for the same
 * reason: the only way to prove a 25-second cap with a real clock is to wait
 * 25 seconds, on every run, forever. A test that slow is one people start
 * skipping.
 * @returns {Promise<{ status: number, body: any|null }>}
 */
export async function handleMcpRequest({ body, credential, coordinator, fetch: doFetch = fetch, now, sleep }) {
  if (!body || typeof body !== 'object') {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'not JSON-RPC' } } };
  }

  const server = new McpServer({
    coordinator,
    credential,
    fetch: doFetch,
    // NOTHING TO WRITE TO. Over stdio the server may speak unprompted; here
    // there is no open channel, so a stray write would be a silent no-op rather
    // than an error. Making it explicit stops somebody adding one and wondering.
    write: () => {},
    // And nothing to watch: the watcher exists to send notifications, which
    // this transport has nowhere to put.
    watchMs: 0,
    maxWaitMs: MAX_REMOTE_WAIT_MS,
    ...(now ? { now } : {}),
    ...(sleep ? { sleep } : {}),
  });

  // A BATCH IS A LIST. The spec allows one, and a client that sends one to a
  // server which answers a single object gets a reply it cannot match.
  if (Array.isArray(body)) {
    const replies = [];
    for (const message of body) {
      const reply = await server.handleMessage(message);
      if (reply) replies.push(reply);
    }
    // All notifications: 202, with no body. Answering `[]` is a JSON-RPC error.
    return replies.length ? { status: 200, body: replies } : { status: 202, body: null };
  }

  const reply = await server.handleMessage(body);
  return reply ? { status: 200, body: reply } : { status: 202, body: null };
}
