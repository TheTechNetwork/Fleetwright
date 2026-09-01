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

// --- ownership, when the fleet chose the name -------------------------------

test('a session the fleet named is still yours to stop', async () => {
  // `start` with no name records the name the FLEET chose. This read
  // `params.name || reply.name`, and a reply has no `name` — it carries
  // `sessions: [record]`, the same shape that made fleet_await blind. So an
  // unnamed start recorded nothing and its session was unstoppable for the
  // rest of the conversation, refused with "not started in this conversation"
  // about a session started seconds earlier.
  //
  // An agent worked this out from behaviour alone — the named session stopped,
  // the auto-named one never did — and left an idle session holding a slot.
  const { McpServer } = await import('../src/mcp/server.js');
  /** @type {string[]} */
  const verbs = [];
  const server = new McpServer({
    coordinator: 'https://fleet.example',
    credential: 'fwk_a_b',
    write: () => {},
    watchMs: 0,
    fetch: async (/** @type {any} */ _url, /** @type {any} */ init) => {
      const body = JSON.parse(String(init?.body || '{}'));
      verbs.push(body.verb);
      return {
        status: 200,
        json: async () => ({
          ok: true,
          text: `${body.verb} ok`,
          // The fleet names it when the caller does not.
          sessions: [{ name: 'cc-tough-stoat', status: 'running' }],
        }),
      };
    },
  });
  /** @param {string} name @param {any} args */
  const call = (name, args) =>
    server.handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });

  await call('fleet_start', { brief: 'a note' });
  const stopped = await call('fleet_stop', { name: 'cc-tough-stoat' });
  assert.equal(stopped.result.isError, undefined, String(stopped.result.content[0].text));
  assert.ok(verbs.includes('stop'), 'the stop never reached the fleet');
});

test('a started session is placeable before the next health frame', async () => {
  // The registry learns sessions only from health frames, so `start` answered
  // "Started X" and an await one call later was refused with "No host reports a
  // session named X. It may exist on a host that is currently offline" — about
  // a session the same host had just confirmed creating. Pushing health after
  // start narrowed that window; the frame still has to travel.
  const { HostRegistry } = await import('../src/fleet/coordinator/registry.js');
  const reg = new HostRegistry({ now: () => 1000 });
  reg.connect('deb13-staging', {});
  reg.recordHealth('deb13-staging', {
    hostId: 'deb13-staging',
    protocol: 2,
    labels: [],
    maxSessions: 5,
    running: 0,
    free: 5,
    resumable: [],
    sessions: [{ name: 'older', status: 'stopped' }],
    loadavg: [0, 0, 0],
    loggedIn: true,
    claudeAccounts: 1,
    hub: { reachable: true },
  });
  assert.deepEqual(reg.findSessions('fresh'), []);

  reg.noteSessions('deb13-staging', [{ name: 'fresh', status: 'running' }]);
  assert.equal(reg.findSessions('fresh').length, 1);
  // MERGED, NOT REPLACED. A start reply describes one session; treating it as
  // the whole truth would erase every other session on that box.
  assert.equal(reg.findSessions('older').length, 1);
});

test('read_log says to collect the output before stopping', async () => {
  // "Survives the session ending, so this is how you collect a result" — but a
  // STOP removes the container, and with it the output. An agent followed the
  // documented order, stopped the session, and was told "no container and no
  // pane" by the tool that had promised to survive.
  const { toolsFor } = await import('../src/mcp/tools.js');
  const tools = toolsFor();
  const read = tools.find((t) => t.name === 'fleet_read_log');
  assert.match(String(read?.description), /BEFORE YOU STOP/);
  const stop = tools.find((t) => t.name === 'fleet_stop');
  assert.match(String(stop?.description), /fleet_read_log FIRST/);
});

// --- parameters that quietly do nothing ------------------------------------

test('brief says it is not the task', async () => {
  // An agent read `brief` as the work to run — reasonably: the schema was
  // `{type:'string', maxLength:500}` and said nothing else. It started a
  // session, waited for a result, and got a REPL at an empty prompt with
  // nothing having failed anywhere. Silence looks like success, which makes a
  // no-op parameter the worst shape a parameter can have.
  const { toolsFor } = await import('../src/mcp/tools.js');
  const start = toolsFor().find((t) => t.name === 'fleet_start');
  const brief = String(start?.inputSchema.properties.brief.description || '');
  assert.match(brief, /NOT the task/);
  assert.match(brief, /never given to the model/);
  // And the tool itself says the session arrives idle, so a plan is not built
  // around handing it work.
  assert.match(String(start?.description), /COMES UP IDLE/);
});

test('every text parameter carries its own words', async () => {
  // The generated schema dropped `describe` on the floor for `text` params, so
  // the two prose fields on `start` arrived with a length limit and no meaning.
  const { toolsFor } = await import('../src/mcp/tools.js');
  const start = toolsFor().find((t) => t.name === 'fleet_start');
  for (const param of ['title', 'brief']) {
    assert.ok(
      String(start?.inputSchema.properties[param].description || '').length > 20,
      `${param} has no description, so a caller has to guess what it does`,
    );
  }
});

test('fleet_health answers with capacity, not the word ok', async () => {
  // `health` replies `{ ok: true, text: 'ok', health: {…} }` and the server
  // rendered `text` alone — so a tool described as "capacity and load" returned
  // the single word "ok". The interesting half was fetched, sent across the
  // fleet, and dropped at the last hop.
  const { McpServer } = await import('../src/mcp/server.js');
  const server = new McpServer({
    coordinator: 'https://fleet.example',
    credential: 'fwk_a_b',
    write: () => {},
    watchMs: 0,
    fetch: async () => ({
      status: 200,
      json: async () => ({
        ok: true,
        text: 'ok',
        health: { running: 2, maxSessions: 5, free: 3, loadavg: [0.1, 0.2, 0.3], labels: ['linux'], loggedIn: false },
      }),
    }),
  });
  const reply = await server.handleMessage({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'fleet_health', arguments: {} },
  });
  const text = String(reply.result.content[0].text);
  assert.notEqual(text, 'ok');
  assert.match(text, /2\/5 sessions running/);
  assert.match(text, /tags: linux/);
  // The one that decides whether a session can do anything at all. A host with
  // free capacity and no login accepts a start and produces a session that
  // cannot work — the confusing kind of healthy.
  assert.match(text, /NOT LOGGED IN/);
});

test('tag says it places work rather than filtering a list', async () => {
  // A tag on `list` is silently ignored — reads fan out across the fleet — so
  // an agent filtering by "macos" got everything back and believed it.
  const { toolsFor } = await import('../src/mcp/tools.js');
  const list = toolsFor().find((t) => t.name === 'fleet_list');
  assert.match(String(list?.inputSchema.properties.tag.description), /does not filter what you are shown/);
});

// --- the reply shape the fleet actually sends --------------------------------
//
// Every test here answers `{ ok, text, sessions: [record] }`, which is what
// `/status <name>` returns (src/adapters/commands.js). The previous tests, and
// the conformance harness, answered `{ session: {...} }` — a key no layer of
// this fleet produces. Everything passed and nothing worked.

test('fleet_await sees a session end, in the shape the coordinator sends', async () => {
  const { McpServer } = await import('../src/mcp/server.js');
  let polls = 0;
  const server = new McpServer({
    coordinator: 'https://fleet.example',
    credential: 'fwk_a_b',
    write: () => {},
    watchMs: 0,
    sleep: async () => {},
    fetch: async () => ({
      status: 200,
      json: async () => {
        // Loud rather than endless: an await that cannot read the reply keeps
        // polling until its own deadline, which with a no-op sleep is a spin.
        if (polls > 20) throw new Error('fleet_await polled 20 times without noticing the session ended');
        return {
        ok: true,
        text: 'job3 — stopped',
        // Running twice, then stopped. An await that cannot read this polls to
        // its own timeout and reports "still running" about a finished job —
        // measured on a real fleet, on both transports.
        sessions: [{ name: 'job3', status: ++polls > 2 ? 'stopped' : 'running' }],
        };
      },
    }),
  });
  // A blind await does not fail, it SPINS — sleep is a no-op here and the
  // deadline is five minutes away, so the old code hung the test runner rather
  // than failing it. A hang is a bad signal: it looks like an infrastructure
  // problem and gets retried. This makes the blindness loud.
  const guard = setTimeout(() => {}, 0);
  clearTimeout(guard);
  const reply = await server.handleMessage({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'fleet_await', arguments: { name: 'job3', seconds: 300 } },
  });
  const text = String(reply.result.content[0].text);
  assert.equal(/still running/.test(text), false, 'it waited out the clock on a finished session');
  assert.match(text, /job3/);
  assert.ok(polls <= 4, `it should stop polling once the session ended, not ${polls} times`);
});

test('the watcher notifies from the same shape', async () => {
  const { McpServer } = await import('../src/mcp/server.js');
  /** @type {any[]} */
  const written = [];
  const server = new McpServer({
    coordinator: 'https://fleet.example',
    credential: 'fwk_a_b',
    write: (/** @type {string} */ line) => written.push(JSON.parse(line)),
    watchMs: 1,
    sleep: async () => {},
    // unref'd, or the watcher's timer keeps the test runner alive forever —
    // which is the same 'stdio server that will not exit' the watcher's own
    // shutdown logic exists to avoid.
    setTimer: (/** @type {() => void} */ fn) => setTimeout(fn, 1).unref?.(),
    fetch: async (/** @type {any} */ _url, /** @type {any} */ init) => {
      const body = JSON.parse(String(init?.body || '{}'));
      if (body.verb === 'status') {
        return {
          status: 200,
          json: async () => ({
            ok: true,
            sessions: [{ name: 'probe', status: 'running', awaiting: true, detail: 'needs an answer' }],
          }),
        };
      }
      return { status: 200, json: async () => ({ ok: true, text: 'started probe' }) };
    },
  });
  await server.handleMessage({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'fleet_start', arguments: { name: 'probe', brief: 'x' } },
  });
  await new Promise((r) => setTimeout(r, 60));
  const notes = written.filter((m) => m.method === 'notifications/message');
  assert.ok(notes.length > 0, 'the watcher emitted nothing — it could not read the status reply');
  assert.match(String(notes[0].params.data.message), /needs an answer/);
});

test('over HTTP, an agent can stop what it started one request earlier', async () => {
  // A new McpServer per request meant the ownership set was always empty, so
  // `stop` refused the caller's OWN session — "it belongs to somebody who is
  // probably still using it", which was false twice over. The instructions
  // delivered over that same transport say to clean up.
  const { handleMcpRequest } = await import('../src/mcp/http.js');
  const credential = `fwk_${Math.random().toString(16).slice(2)}_stopscope`;
  /** @type {string[]} */
  const verbs = [];
  const fetchStub = async (/** @type {any} */ _url, /** @type {any} */ init) => {
    const body = JSON.parse(String(init?.body || '{}'));
    verbs.push(body.verb);
    return { status: 200, json: async () => ({ ok: true, text: `${body.verb} ok` }) };
  };
  /** @param {string} name @param {any} args */
  const call = (name, args) =>
    handleMcpRequest({
      body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
      credential,
      coordinator: 'https://fleet.example',
      fetch: /** @type {any} */ (fetchStub),
    });

  await call('fleet_start', { name: 'job1', brief: 'do a thing' });
  const stopped = await call('fleet_stop', { name: 'job1' });
  assert.equal(stopped.body.result.isError, undefined, String(stopped.body.result.content[0].text));
  assert.ok(verbs.includes('stop'), 'the stop never reached the fleet');

  // And the scoping still holds: somebody else's session is still refused.
  const other = await call('fleet_stop', { name: 'not-mine' });
  assert.equal(other.body.result.isError, true);
  assert.match(String(other.body.result.content[0].text), /not yours to stop/);
});

test('a batch over stdio is answered, not silently dropped', async () => {
  // handleLine handed the ARRAY to handleMessage, where `array.id` is
  // undefined — so it was treated as a notification, answered with nothing, and
  // the error swallowed. No reply, no stderr. HTTP handled the same batch
  // correctly, which made "the identical conversation in a different envelope"
  // false in the one place it is written down.
  const { McpServer } = await import('../src/mcp/server.js');
  /** @type {any[]} */
  const written = [];
  const server = new McpServer({
    coordinator: 'https://fleet.example',
    credential: 'fwk_a_b',
    write: (/** @type {string} */ line) => written.push(JSON.parse(line)),
    watchMs: 0,
  });
  await server.handleLine(
    JSON.stringify([
      { jsonrpc: '2.0', id: 12, method: 'ping' },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 13, method: 'tools/list' },
    ]),
  );
  assert.equal(written.length, 1, 'a batch gets one array reply');
  assert.ok(Array.isArray(written[0]));
  // Two replies, not three: the notification is not answered.
  assert.deepEqual(written[0].map((/** @type {any} */ m) => m.id), [12, 13]);

  // An all-notifications batch is answered with nothing at all.
  written.length = 0;
  await server.handleLine(JSON.stringify([{ jsonrpc: '2.0', method: 'notifications/initialized' }]));
  assert.equal(written.length, 0);
});

test('the seconds ceiling advertised is the one the caller gets', async () => {
  // 900 was advertised on both transports while HTTP capped a wait at 25s. An
  // agent could ask for two minutes, plan around it, and be answered in
  // twenty-five seconds — legible afterwards from the prose, invisible before.
  const { toolsFor } = await import('../src/mcp/tools.js');
  const capped = toolsFor({ maxWaitSeconds: 25 }).find((t) => t.name === 'fleet_await');
  assert.equal(capped?.inputSchema.properties.seconds.maximum, 25);
  assert.match(String(capped?.inputSchema.properties.seconds.description), /call again/);
  const uncapped = toolsFor().find((t) => t.name === 'fleet_await');
  assert.equal(uncapped?.inputSchema.properties.seconds.maximum, 900);
});

// --- SSRF: the Host header must not choose where we send things -------------

test('a spoofed Host cannot steer the coordinator\'s outbound request', async (t) => {
  const { c, base } = await coordinator(t);
  const { token } = await c.core.issueClient({ email: 'owner@example.com', name: 'The Owner' }, 'a test');

  // Somewhere the coordinator must never be persuaded to send an intent. It
  // records any hit, and the assertion is that it stays empty.
  const { createServer } = await import('node:http');
  /** @type {string[]} */
  const hits = [];
  const trap = createServer((req, res) => {
    hits.push(String(req.url));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true,"text":"you reached the wrong machine"}');
  });
  await new Promise((r) => trap.listen(0, '127.0.0.1', () => r(null)));
  const trapPort = /** @type {any} */ (trap.address()).port;
  t.after(() => trap.close());

  // node:http rather than fetch, because undici refuses to let a caller set
  // Host — and an attacker is not using undici.
  const { request } = await import('node:http');
  const reply = await new Promise((resolve) => {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'fleet_list', arguments: {} },
    });
    const req = request(
      {
        hostname: '127.0.0.1',
        port: Number(new URL(base).port),
        path: '/mcp',
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          authorization: `Bearer ${token}`,
          // THE ATTACK. If the outbound intent is built from this, the
          // coordinator makes a request to a machine the caller named — with
          // the coordinator's network position, from inside wherever it runs.
          host: `127.0.0.1:${trapPort}`,
        },
      },
      (res) => {
        let text = '';
        res.on('data', (chunk) => (text += chunk));
        res.on('end', () => resolve(text));
      },
    );
    req.end(body);
  });

  assert.deepEqual(hits, [], 'the Host header chose where the coordinator sent its intent');
  // And it answered — from the real fleet, which has no hosts connected.
  const parsed = JSON.parse(String(reply));
  assert.equal(/you reached the wrong machine/.test(JSON.stringify(parsed)), false);
});

test('the discovery documents DO follow the Host header, and should', async (t) => {
  const { base } = await coordinator(t);
  // The other half of the rule, and the reason this is two values rather than
  // one hardened one: a client must be pointed back at the address it actually
  // used, or the flow it is about to start goes somewhere it cannot reach. A
  // spoofed Host here only ever poisons the spoofer's own response.
  const { request } = await import('node:http');
  const doc = await new Promise((resolve) => {
    const req = request(
      {
        hostname: '127.0.0.1',
        port: Number(new URL(base).port),
        path: '/.well-known/oauth-protected-resource',
        method: 'GET',
        headers: { host: 'fleet.example.test' },
      },
      (res) => {
        let text = '';
        res.on('data', (c) => (text += c));
        res.on('end', () => resolve(text));
      },
    );
    req.end();
  });
  assert.equal(JSON.parse(String(doc)).resource, 'http://fleet.example.test/mcp');
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
