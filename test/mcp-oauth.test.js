import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Authorizations,
  authorizationServerMetadata,
  protectedResourceMetadata,
  isSafeRedirect,
  s256,
} from '../src/mcp/oauth.js';
import { handleMcpRequest } from '../src/mcp/http.js';

const ORIGIN = 'https://fleet.example';

test('PKCE follows RFC 7636, not this repo\'s other hash helper', async () => {
  // The coordinator's `hashSecret` returns HEX. PKCE requires BASE64URL, and
  // reusing the wrong one would reject every valid verifier — a failure that
  // looks like a client bug from both ends. This is the RFC's own vector.
  assert.equal(
    await s256('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'),
    'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
  );
});

test('discovery points a client at the whole flow from one URL', () => {
  // The point of the metadata: a client that has never seen this fleet needs no
  // configuration beyond the address, because registration is an endpoint.
  const meta = authorizationServerMetadata(ORIGIN);
  assert.equal(meta.registration_endpoint, `${ORIGIN}/oauth/register`);
  assert.deepEqual(meta.code_challenge_methods_supported, ['S256']);
  // No plain. A public client without PKCE is an authorization code anybody
  // who can see the redirect can spend.
  assert.equal(meta.code_challenge_methods_supported.includes('plain'), false);
  assert.deepEqual(protectedResourceMetadata(ORIGIN).authorization_servers, [ORIGIN]);
});

test('a redirect must be somewhere a code can safely land', () => {
  // Loopback http is how every local client receives one, and refusing it
  // refuses the ordinary case. Cleartext to anywhere else is a code readable
  // by anyone on the path — SEC-NET-1 in another costume.
  assert.equal(isSafeRedirect('http://127.0.0.1:49152/callback'), true);
  assert.equal(isSafeRedirect('http://localhost:8080/cb'), true);
  assert.equal(isSafeRedirect('https://claude.ai/api/mcp/auth_callback'), true);
  assert.equal(isSafeRedirect('myapp://auth'), true);

  assert.equal(isSafeRedirect('http://evil.example/steal'), false);
  assert.equal(isSafeRedirect('javascript:alert(1)'), false);
  assert.equal(isSafeRedirect('data:text/html,hi'), false);
  assert.equal(isSafeRedirect('not a url'), false);
});

test('registration grants nothing on its own', async () => {
  // Open by design: a client_id cannot read anything, start anything, or exist
  // usefully without a person completing a sign-in against an allowlist.
  // Refusing to register is refusing to be discoverable, which is the one thing
  // the endpoint is for.
  const auth = new Authorizations();
  const r = auth.register({ redirect_uris: ['http://127.0.0.1:9000/cb'], client_name: 'Claude' });
  assert.equal(r.ok, true);
  assert.match(r.clientId, /^mcp_/);
  assert.equal(auth.register({ redirect_uris: [] }).ok, false);
  assert.equal(auth.register({ redirect_uris: ['http://evil.example/x'] }).ok, false);
});

test('a code is bound to the client, the redirect and the verifier', async () => {
  const auth = new Authorizations();
  const { clientId } = auth.register({ redirect_uris: ['http://127.0.0.1:9000/cb'] });
  const verifier = 'a'.repeat(64);
  const challenge = await s256(verifier);

  const issued = auth.issueCode({ email: 'eli@example.com', clientId, redirectUri: 'http://127.0.0.1:9000/cb', challenge });
  assert.equal(issued.ok, true);

  // The happy path.
  const good = await auth.redeem({ code: issued.code, clientId, redirectUri: 'http://127.0.0.1:9000/cb', verifier });
  assert.equal(good.ok, true);
  assert.equal(good.email, 'eli@example.com');
});

test('a code cannot be spent twice', async () => {
  // Deleted BEFORE anything else can fail, so a rejected exchange does not
  // leave one somebody can retry.
  const auth = new Authorizations();
  const { clientId } = auth.register({ redirect_uris: ['http://127.0.0.1:9000/cb'] });
  const verifier = 'b'.repeat(64);
  const { code } = auth.issueCode({ email: 'e@x.com', clientId, redirectUri: 'http://127.0.0.1:9000/cb', challenge: await s256(verifier) });

  assert.equal((await auth.redeem({ code, clientId, redirectUri: 'http://127.0.0.1:9000/cb', verifier })).ok, true);
  assert.equal((await auth.redeem({ code, clientId, redirectUri: 'http://127.0.0.1:9000/cb', verifier })).ok, false);
});

test('a stolen code is useless without the verifier', async () => {
  // Which is the entire reason PKCE is required rather than offered.
  const auth = new Authorizations();
  const { clientId } = auth.register({ redirect_uris: ['http://127.0.0.1:9000/cb'] });
  const { code } = auth.issueCode({ email: 'e@x.com', clientId, redirectUri: 'http://127.0.0.1:9000/cb', challenge: await s256('the real one') });

  const thief = await auth.redeem({ code, clientId, redirectUri: 'http://127.0.0.1:9000/cb', verifier: 'a guess' });
  assert.equal(thief.ok, false);
  assert.equal(thief.error, 'invalid_grant');
});

test('a code cannot be redirected somewhere it was not issued for', async () => {
  // Without checking the redirect against what was REGISTERED, anybody who
  // knows a client_id can have the code sent to themselves.
  const auth = new Authorizations();
  const { clientId } = auth.register({ redirect_uris: ['http://127.0.0.1:9000/cb'] });
  const bad = auth.issueCode({ email: 'e@x.com', clientId, redirectUri: 'https://evil.example/cb', challenge: 'x' });
  assert.equal(bad.ok, false);
  assert.equal(bad.error, 'invalid_redirect_uri');
});

test('an expired code is refused', async () => {
  let now = 0;
  const auth = new Authorizations({ now: () => now });
  const { clientId } = auth.register({ redirect_uris: ['http://127.0.0.1:9000/cb'] });
  const verifier = 'c'.repeat(64);
  const { code } = auth.issueCode({ email: 'e@x.com', clientId, redirectUri: 'http://127.0.0.1:9000/cb', challenge: await s256(verifier) });
  now += 10 * 60_000;
  assert.equal((await auth.redeem({ code, clientId, redirectUri: 'http://127.0.0.1:9000/cb', verifier })).ok, false);
});

// --- the transport ----------------------------------------------------------

test('the same conversation, in a different envelope', async () => {
  // stdio wraps handleMessage in newlines; this wraps it in a request. A second
  // implementation of the conversation would be a second thing to get wrong.
  const r = await handleMcpRequest({
    body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } },
    credential: 'fwk_a_b',
    coordinator: 'https://fleet.example',
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.result.protocolVersion, '2025-11-25');
  assert.ok(r.body.result.capabilities.tools);
});

test('a notification gets 202 and no body', async () => {
  // Answering `{}` to something with no id is a JSON-RPC error a client cannot
  // match to anything.
  const r = await handleMcpRequest({
    body: { jsonrpc: '2.0', method: 'notifications/initialized' },
    credential: 'fwk_a_b',
    coordinator: 'https://fleet.example',
  });
  assert.equal(r.status, 202);
  assert.equal(r.body, null);
});

test('a batch is answered as a batch', async () => {
  const r = await handleMcpRequest({
    body: [
      { jsonrpc: '2.0', id: 1, method: 'ping' },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'ping' },
    ],
    credential: 'fwk_a_b',
    coordinator: 'https://fleet.example',
  });
  assert.equal(r.status, 200);
  // Two replies, not three: the notification is not answered.
  assert.equal(r.body.length, 2);
  assert.deepEqual(r.body.map((m) => m.id), [1, 2]);
});

test('a blocking tool is capped below the transport\'s timeout', async () => {
  // Over stdio a five-minute wait is a five-minute wait. Over HTTP an uncapped
  // one is a dropped connection, and a client cannot tell a slow session from a
  // broken server.
  let asked = 0;
  const r = await handleMcpRequest({
    body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'fleet_await', arguments: { name: 'x', seconds: 900 } } },
    credential: 'fwk_a_b',
    coordinator: 'https://fleet.example',
    fetch: async () => {
      asked++;
      return { status: 200, json: async () => ({ ok: true, session: { status: 'running' } }) };
    },
  });
  // It answered rather than hanging, and told the caller how to keep waiting.
  assert.match(r.body.result.content[0].text, /still running after 25s/);
  assert.match(r.body.result.content[0].text, /call fleet_await again/);
});
