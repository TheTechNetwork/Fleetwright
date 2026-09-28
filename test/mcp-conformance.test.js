// The MCP SDK's client, driven against OUR authorization server and OUR
// transport — the conformance oracle docs/auth-and-join.md asked for.
//
// Everything under src/mcp/ is hand-written: RFC 9728 → 8414 → 7591 → PKCE →
// token, and a Streamable HTTP transport. test/mcp-remote.test.js proves each
// route does what we think it does, by hand, with requests we wrote. What it
// cannot prove is that a client we did NOT write — one that reads the specs the
// way the specs' own reference implementation reads them — gets through. That
// is the failure mode the jose paragraph in docs/dependencies.md names: not a
// crash, a quiet mismatch found by the first real client.
//
// So the SDK is a devDependency, and this file is the only place it is used.
// It is the CLIENT half only: the authorization server and the transport stay
// ours, and whether Cloudflare's OAuth provider library is ever taken in their
// place is decided by what this file finds.
//
// THE ONE STEP A TEST CANNOT DO IS SIGN IN. The authorize page runs Apple's or
// Google's JavaScript in a person's browser and posts the ID token back. Here
// the code is issued straight from the store the page would have written to,
// with the challenge the SDK put on the URL — the same shortcut
// mcp-remote.test.js takes, for the same reason. Everything before and after
// that step is the SDK's own code talking to ours.

import test from 'node:test';
import assert from 'node:assert/strict';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';

import { Coordinator } from './helpers/node-coordinator.js';

const silent = { info() {}, warn() {}, error() {}, debug() {} };

/**
 * A coordinator with sign-in configured, on a loopback port. No admin token:
 * these routes have to work on a coordinator whose only credentials are
 * per-person, which is every real one.
 * @param {import('node:test').TestContext} t
 */
async function coordinator(t) {
  const before = { ...process.env };
  process.env.AGENT_FLEET_AUTH_ISSUERS = 'https://accounts.google.com';
  process.env.AGENT_FLEET_AUTH_AUDIENCES = '123-abc.apps.googleusercontent.com';
  process.env.AGENT_FLEET_AUTH_ALLOW = 'owner@example.com';
  const c = new Coordinator({ logger: silent });
  const port = await c.listen(0, '127.0.0.1');
  t.after(async () => {
    await c.close();
    process.env = before;
  });
  return { c, base: `http://127.0.0.1:${port}` };
}

/**
 * What an MCP client keeps between the redirect out and the redirect back:
 * its registration, its PKCE verifier, and eventually its tokens. In memory,
 * and the redirect is captured rather than followed — there is no browser.
 */
function clientStore() {
  /** @type {any} */ let information;
  /** @type {any} */ let tokens;
  /** @type {string|undefined} */ let verifier;
  /** @type {URL|null} */ let redirectedTo = null;
  /** @type {import('@modelcontextprotocol/sdk/client/auth.js').OAuthClientProvider} */
  const provider = {
    redirectUrl: 'http://127.0.0.1:51000/callback',
    clientMetadata: {
      redirect_uris: ['http://127.0.0.1:51000/callback'],
      client_name: 'the conformance oracle',
      grant_types: ['authorization_code'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    },
    clientInformation: () => information,
    saveClientInformation: (info) => { information = info; },
    tokens: () => tokens,
    saveTokens: (t) => { tokens = t; },
    redirectToAuthorization: (url) => { redirectedTo = url; },
    saveCodeVerifier: (v) => { verifier = v; },
    codeVerifier: () => { if (!verifier) throw new Error('no verifier saved'); return verifier; },
  };
  return { provider, redirected: () => redirectedTo, tokens: () => tokens, information: () => information };
}

test('the SDK client discovers, registers, is sent to sign in, exchanges the code and talks MCP — against our server', async (t) => {
  const { c, base } = await coordinator(t);
  const store = clientStore();

  // 1. A cold connect: the SDK hits /mcp, reads the 401's WWW-Authenticate,
  //    fetches the protected-resource document, then the authorization-server
  //    document, registers itself dynamically, builds the authorize URL with a
  //    PKCE challenge, and hands it to the provider to "open a browser".
  const first = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { authProvider: store.provider });
  const cold = new Client({ name: 'oracle', version: '0' });
  await assert.rejects(cold.connect(first), UnauthorizedError, 'a client with no token is told to go and get one');
  await first.close().catch(() => {});

  const url = store.redirected();
  assert.ok(url, 'the SDK reached the redirect: discovery and registration succeeded');
  assert.equal(url.origin + url.pathname, `${base}/oauth/authorize`);
  const registered = store.information();
  assert.match(String(registered?.client_id), /^mcp_/, 'dynamic registration answered in the shape the SDK parses');
  assert.equal(url.searchParams.get('client_id'), registered.client_id);
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('redirect_uri'), 'http://127.0.0.1:51000/callback');
  const challenge = url.searchParams.get('code_challenge');
  assert.ok(challenge);

  // 2. The person signs in. See the header: the page's job, done from here.
  const issued = c.core.mcpAuthorizations.issueCode({
    email: 'owner@example.com',
    name: 'The Owner',
    clientId: registered.client_id,
    redirectUri: 'http://127.0.0.1:51000/callback',
    challenge,
  });
  assert.equal(issued.ok, true);

  // 3. The redirect comes back with the code; the SDK spends it with the
  //    verifier it kept, at OUR token endpoint, and stores what it gets.
  const second = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { authProvider: store.provider });
  await second.finishAuth(/** @type {any} */ (issued).code);
  const tokens = store.tokens();
  assert.match(String(tokens?.access_token), /^fwk_/, 'the access token IS a device credential');
  assert.equal(String(tokens?.token_type).toLowerCase(), 'bearer');

  // 4. And now it is a member. initialize, the initialized notification (a
  //    202 with no body, which some servers get wrong), tools/list from the
  //    generated catalogue, and one call.
  const client = new Client({ name: 'oracle', version: '0' });
  await client.connect(second);
  t.after(() => client.close().catch(() => {}));
  const { tools } = await client.listTools();
  const names = tools.map((tool) => tool.name);
  assert.ok(names.includes('fleet_list'), `fleet_list is offered; got ${names.join(', ')}`);
  assert.ok(names.includes('fleet_health'));
  assert.equal(names.includes('fleet_purge'), false, 'the withheld verbs stay withheld to a real client too');

  const listed = await client.callTool({ name: 'fleet_list', arguments: {} });
  assert.ok(Array.isArray(listed.content), 'a tool result in the shape the SDK parses');
  // Nothing has ever connected to this coordinator, and it says exactly that,
  // in a sentence — as a tool error the SDK surfaces, not as a thrown
  // exception or an empty list pretending to be a fleet (C-5).
  assert.equal(listed.isError, true);
  assert.match(String(/** @type {any} */ (listed.content)[0]?.text), /No host has ever connected/);

  // 5. The credential the SDK holds shows up where a person would revoke it.
  const clients = c.core.clients.list();
  assert.ok(clients.some((k) => k.email === 'owner@example.com' && /MCP client/i.test(k.name)), 'issued as an MCP device of the person who signed in');
});

test('a revoked credential sends the SDK client back to sign in, not into a loop', async (t) => {
  const { c, base } = await coordinator(t);
  const store = clientStore();

  const first = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { authProvider: store.provider });
  await assert.rejects(new Client({ name: 'oracle', version: '0' }).connect(first), UnauthorizedError);
  await first.close().catch(() => {});
  const url = /** @type {URL} */ (store.redirected());
  const issued = /** @type {any} */ (c.core.mcpAuthorizations.issueCode({
    email: 'owner@example.com', name: null, clientId: store.information().client_id,
    redirectUri: 'http://127.0.0.1:51000/callback', challenge: url.searchParams.get('code_challenge'),
  }));
  const second = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { authProvider: store.provider });
  await second.finishAuth(issued.code);
  const connected = new Client({ name: 'oracle', version: '0' });
  await connected.connect(second);
  await connected.close();

  // Revoked from the People screen, as a person would.
  const mine = c.core.clients.list().find((k) => k.email === 'owner@example.com');
  assert.ok(mine);
  c.core.revokeClient(mine.id);

  // The stored token is now worthless. The SDK sees the 401, finds no refresh
  // token to try (we issue none, on purpose), and asks the person to sign in
  // again — which is the answer, and not a retry storm against /oauth/token.
  const third = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { authProvider: store.provider });
  await assert.rejects(new Client({ name: 'oracle', version: '0' }).connect(third), UnauthorizedError);
  await third.close().catch(() => {});
});
