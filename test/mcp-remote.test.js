// The remote MCP endpoint, through a REAL coordinator.
//
// test/mcp-oauth.test.js already covers PKCE, redirect safety, single-use codes
// and the rest, by calling mcpRoutes() directly. Everything there passed while
// nothing served the endpoint at all — the route table was written, tested, and
// wired into neither coordinator, so `POST /mcp` was a 401 from the token gate
// with no `WWW-Authenticate` header and no way for a client to get further.
//
// That is this repository's recurring failure in its usual costume: TRUE WHERE
// IT WAS WRITTEN, QUIETLY FALSE ONE LAYER UP. So these tests go through the
// coordinator's own HTTP server, over a socket, exactly as a client would.

import test from 'node:test';
import assert from 'node:assert/strict';

import { Coordinator } from '../src/fleet/coordinator/server.js';
import worker from '../worker/src/worker.js';
import { isMcpPath } from '../src/mcp/routes.js';
import { s256 } from '../src/mcp/oauth.js';

/**
 * A coordinator with sign-in configured, on a loopback port.
 *
 * No admin token: these routes have to work on a coordinator whose only
 * credentials are per-person, which is every real one.
 *
 * @param {import('node:test').TestContext} t
 */
async function coordinator(t) {
  const before = { ...process.env };
  process.env.AGENT_FLEET_AUTH_ISSUERS = 'https://accounts.google.com';
  process.env.AGENT_FLEET_AUTH_AUDIENCES = '123-abc.apps.googleusercontent.com,network.thetech.fleetwright';
  process.env.AGENT_FLEET_AUTH_ALLOW = 'owner@example.com';
  const c = new Coordinator();
  const port = await c.listen(0, '127.0.0.1');
  t.after(async () => {
    await c.close();
    process.env = before;
  });
  return { c, base: `http://127.0.0.1:${port}` };
}

// --- discovery, which happens before anybody has a credential ---------------

test('a client with no credential can discover how to get one', async (t) => {
  const { base } = await coordinator(t);

  // THE 401 IS THE ENTRY POINT. Without the header, a client reports the
  // endpoint as broken rather than as protected and never looks for the rest.
  const refused = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
  });
  assert.equal(refused.status, 401);
  const challenge = String(refused.headers.get('www-authenticate'));
  assert.match(challenge, /^Bearer /);
  assert.match(challenge, /resource_metadata="http:\/\/127\.0\.0\.1:\d+\/\.well-known\/oauth-protected-resource"/);

  // And the document it names exists, and names the authorization server.
  const resource = await fetch(`${base}/.well-known/oauth-protected-resource`);
  assert.equal(resource.status, 200);
  const meta = /** @type {any} */ (await resource.json());
  // The RESOURCE is the endpoint, not the origin (RFC 9728) — a client sends
  // this back as the `resource` parameter, and the origin would not match.
  assert.equal(meta.resource, `${base}/mcp`);
  assert.deepEqual(meta.authorization_servers, [base]);

  const server = await fetch(`${base}/.well-known/oauth-authorization-server`);
  assert.equal(server.status, 200);
  const as = /** @type {any} */ (await server.json());
  assert.equal(as.registration_endpoint, `${base}/oauth/register`);
  // PKCE, advertised. A client that cannot see S256 here may not send one.
  assert.deepEqual(as.code_challenge_methods_supported, ['S256']);
});

// --- the flow, end to end ---------------------------------------------------

test('register, sign in, spend the code, and talk MCP', async (t) => {
  const { c, base } = await coordinator(t);

  const registered = await fetch(`${base}/oauth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ redirect_uris: ['http://127.0.0.1:51000/callback'], client_name: 'a test client' }),
  });
  assert.equal(registered.status, 201);
  const { client_id: clientId } = /** @type {any} */ (await registered.json());
  assert.match(clientId, /^mcp_/);

  // The page. Its content is tested in mcp-oauth.test.js; what matters here is
  // that a browser reaches it at all, and gets HTML rather than a JSON refusal.
  const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
  const challenge = await s256(verifier);
  const q = new URLSearchParams({
    client_id: clientId,
    redirect_uri: 'http://127.0.0.1:51000/callback',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'xyz',
    response_type: 'code',
  });
  const page = await fetch(`${base}/oauth/authorize?${q}`);
  assert.equal(page.status, 200);
  assert.match(String(page.headers.get('content-type')), /text\/html/);
  const html = await page.text();
  // The Google client id out of the audience list, and no Apple button, because
  // no Services ID is configured. An Apple button that cannot work is worse
  // than none: it fails at Apple with `invalid_client` and explains nothing.
  //
  // Matched WHERE IT IS USED, not merely present somewhere in the page. A bare
  // includes() of a hostname passes if the string turns up in a comment, and
  // CodeQL flags the shape for the same reason it is a weak assertion.
  assert.match(html, /client_id: "123-abc\.apps\.googleusercontent\.com"/);
  assert.equal(/appleid/.test(html), false);

  // Signing in for real needs Google to sign something, so the ID token is the
  // one thing stubbed — issueCode is what the POST would have called.
  const issued = c.core.mcpAuthorizations.issueCode({
    email: 'owner@example.com',
    name: 'The Owner',
    clientId,
    redirectUri: 'http://127.0.0.1:51000/callback',
    challenge,
  });
  assert.equal(issued.ok, true);

  // FORM-ENCODED, because RFC 6749 says so and clients do it. This is the step
  // that fails if a coordinator reads only JSON — at the very end of a flow the
  // person has already completed.
  const token = await fetch(`${base}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: /** @type {any} */ (issued).code,
      client_id: clientId,
      redirect_uri: 'http://127.0.0.1:51000/callback',
      code_verifier: verifier,
    }),
  });
  assert.equal(token.status, 200);
  const grant = /** @type {any} */ (await token.json());
  assert.equal(grant.token_type, 'Bearer');
  assert.match(grant.access_token, /^fwk_/);
  // AN ACCESS TOKEN IS A DEVICE CREDENTIAL, in the same list as every phone,
  // revocable the same way. That is the whole reason there are no refresh
  // tokens: there is only one kind of credential to reason about.
  const named = c.core.clients.list().find((/** @type {any} */ r) => r.name.includes('an MCP client'));
  assert.ok(named, 'the credential should be listed as what it is');
  assert.equal(named.email, 'owner@example.com');

  // And it works.
  const talk = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${grant.access_token}` },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
    }),
  });
  assert.equal(talk.status, 200);
  const reply = /** @type {any} */ (await talk.json());
  // The version the client asked for, not a hardcoded one. Claude Code 2.1.251
  // opens with 2025-11-25 and reported "server does not advertise tools
  // capability" when this was pinned to 2024-11-05 — while 32 unit tests passed.
  assert.equal(reply.result.protocolVersion, '2025-11-25');
  assert.ok(reply.result.capabilities.tools);

  // A code is single use. Spending it twice is what a stolen one looks like.
  const again = await fetch(`${base}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: /** @type {any} */ (issued).code,
      client_id: clientId,
      redirect_uri: 'http://127.0.0.1:51000/callback',
      code_verifier: verifier,
    }),
  });
  assert.equal(again.status, 400);
});

test('a batch is a list, and a batch of notifications gets 202 with no body', async (t) => {
  const { c, base } = await coordinator(t);
  const { token } = await c.core.issueClient({ email: 'owner@example.com', name: 'The Owner' }, 'a test');

  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify([{ jsonrpc: '2.0', method: 'notifications/initialized' }]),
  });
  // 202 and NOTHING. `[]` is a JSON-RPC error, and a body with no id is one the
  // client cannot match to anything.
  assert.equal(res.status, 202);
  assert.equal(await res.text(), '');
});

test('an unknown client is refused before anybody signs in', async (t) => {
  const { base } = await coordinator(t);
  // issueCode already refuses this — but only AFTER a person has handed their
  // password to Google, which is the one failure this flow must not have. A
  // coordinator that has forgotten a registration says so first.
  const q = new URLSearchParams({
    client_id: 'mcp_neverseen',
    redirect_uri: 'http://127.0.0.1:51000/callback',
    code_challenge: 'x'.repeat(43),
    code_challenge_method: 'S256',
  });
  const page = await fetch(`${base}/oauth/authorize?${q}`);
  assert.equal(page.status, 400);
  assert.match(await page.text(), /register itself/);
});

// --- the bug this wiring nearly shipped -------------------------------------

test('wiring MCP in did not eat every other POST body', async (t) => {
  const { base } = await coordinator(t);
  // The first version of the dispatch read the request body to decide whether
  // the route was one of its own. That consumes the stream, so every handler
  // below it received an empty request — not a 404, but a route that silently
  // gets nothing. `/api/session` reading its idToken is the proof it still has
  // a body to read.
  const res = await fetch(`${base}/api/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ idToken: 'not.a.jwt' }),
  });
  assert.equal(res.status, 401);
  const body = /** @type {any} */ (await res.json());
  assert.equal(body.error.code, 'unauthorised');
  // The reason names the token, which it can only do having read one.
  assert.match(body.text, /JWT/i);
});

// --- the crash that only the Worker had -------------------------------------

test('the global fetch is called with a receiver Cloudflare will accept', async () => {
  // `this.fetch = fetch` and then `this.fetch(...)` calls the global with an
  // McpServer as its receiver. Node's fetch does not care. Cloudflare's throws:
  //
  //     Illegal invocation: function called with incorrect `this` reference.
  //
  // So every tool call on the deployed Worker failed, identically, below the
  // layer that writes this server's careful refusals — an agent sent to use the
  // fleet concluded the whole fleet was down. Stdio worked. 1010 tests passed.
  //
  // This stands in for the Workers runtime by refusing the same receiver.
  const { McpServer } = await import('../src/mcp/server.js');
  const original = globalThis.fetch;
  /** @type {string} */
  let receiver = 'never called';
  globalThis.fetch = /** @type {any} */ (
    function (/** @type {any} */ _url, /** @type {any} */ _init) {
      // A real global sees `this` as undefined (module code is strict) or the
      // global object. Anything else is the bug.
      // @ts-expect-error - `this` is exactly what is under test
      const self = this;
      if (self !== undefined && self !== globalThis) {
        receiver = 'wrong';
        throw new TypeError('Illegal invocation: function called with incorrect `this` reference.');
      }
      receiver = 'ok';
      return Promise.resolve({ status: 200, json: async () => ({ ok: true, text: 'sunlit-harbor on deb132' }) });
    }
  );
  try {
    const server = new McpServer({
      coordinator: 'https://fleet.example',
      credential: 'fwk_a_b',
      write: () => {},
      watchMs: 0,
    });
    const reply = await server.handleMessage({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'fleet_list', arguments: {} },
    });
    assert.equal(receiver, 'ok', 'the global fetch was called with the wrong `this`');
    assert.equal(reply.result.isError, undefined);
    assert.match(reply.result.content[0].text, /sunlit-harbor/);
  } finally {
    globalThis.fetch = original;
  }
});

test('a bug in this server does not get reported as a fleet outage', async () => {
  // "Could not reach the fleet" was said for every failure, including a crash
  // inside this file. It is a claim about the network, and it sent a caller
  // looking at hosts, connectivity and their own credential — none of which
  // were involved. A caller can act on "retry" and on "tell the operator"; they
  // cannot act on a sentence naming the wrong layer.
  const { McpServer } = await import('../src/mcp/server.js');
  /** @param {Error} thrown */
  const textFor = async (thrown) => {
    const server = new McpServer({
      coordinator: 'https://fleet.example',
      credential: 'fwk_a_b',
      write: () => {},
      watchMs: 0,
      fetch: async () => {
        throw thrown;
      },
    });
    const reply = await server.handleMessage({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'fleet_list', arguments: {} },
    });
    return String(reply.result.content[0].text);
  };

  const internal = await textFor(new TypeError('Illegal invocation: function called with incorrect `this` reference.'));
  assert.match(internal, /bug in the server/);
  assert.match(internal, /nothing you change/i);
  assert.equal(/Could not reach the fleet/.test(internal), false);

  const outage = await textFor(new Error('connect ECONNREFUSED 10.0.0.4:8791'));
  assert.match(outage, /Could not reach the fleet/);
  assert.match(outage, /retrying is reasonable/);
});

test('the two log tools ask different questions', async () => {
  // They both said "read a session's output, it survives the session ending",
  // and an agent testing this server reported them as near-duplicates it could
  // not choose between. It was right — nothing distinguished them.
  const { toolsFor } = await import('../src/mcp/tools.js');
  const tools = toolsFor();
  const journal = tools.find((t) => t.name === 'fleet_logs');
  const session = tools.find((t) => t.name === 'fleet_read_log');
  assert.ok(journal && session);

  // The service half and the session half, and neither offers the other's.
  assert.deepEqual(Object.keys(journal.inputSchema.properties).sort(), ['host', 'lines', 'service', 'tag']);
  assert.deepEqual(Object.keys(session.inputSchema.properties).sort(), ['host', 'lines', 'name', 'tag']);
  // `name` is what fleet_read_log exists for. Narrowing the base tool before
  // the alias copied its properties took it away once.
  assert.deepEqual(session.inputSchema.required, ['name']);
});

// --- and the Worker serves the same list ------------------------------------

test('the Worker forwards every MCP path to the object, with no credential', async () => {
  // A path served in the object and not forwarded here is a 401 with no
  // explanation — the same drift that left `/api/devices` 404ing on one
  // coordinator for months.
  const paths = [
    '/mcp',
    '/oauth/register',
    '/oauth/authorize',
    '/oauth/token',
    '/.well-known/oauth-protected-resource',
    '/.well-known/oauth-authorization-server',
    '/.well-known/openid-configuration',
  ];
  // The list this test walks IS the list the coordinators dispatch on, rather
  // than a copy of it that could fall behind.
  for (const p of paths) assert.equal(isMcpPath(p), true, p);

  /** @type {string[]} */
  const reached = [];
  const fleet = {
    idFromName: () => 'id',
    get: () => ({
      fetch: async (/** @type {Request} */ r) => {
        reached.push(new URL(r.url).pathname);
        return new Response('{}');
      },
    }),
  };
  const env = /** @type {any} */ ({ FLEET: fleet, AGENT_FLEET_API_TOKEN: 'a-token-at-least-16ch' });
  for (const p of paths) await worker.fetch(new Request(`https://fleet.example${p}`), env);
  assert.deepEqual(reached, paths);
});

test('a revoked credential on /mcp is told where to sign in again', async () => {
  // Above the credential check in the object, not merely above the routes. The
  // generic 401 carries no WWW-Authenticate, so a client that used to work
  // would have no way to discover it should sign in again.
  const src = await (await import('node:fs/promises')).readFile(
    new URL('../worker/src/fleet-do.js', import.meta.url),
    'utf8',
  );
  const mcp = src.indexOf('if (isMcpPath(url.pathname))');
  const credential = src.indexOf('const presented = credentialFrom(');
  assert.ok(mcp > 0 && credential > 0);
  assert.ok(mcp < credential, 'the MCP dispatch must come before the device-credential check');
});
